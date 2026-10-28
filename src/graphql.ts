// GraphQL servers: GraphQL Yoga (`plugins: [tracepanelYogaPlugin()]`) and Apollo Server (`plugins: [tracepanelApolloPlugin()]`).
// Their traces look like the Python SDK's of Strawberry and Graphene, so the console shows every server's the same
// way: the request is named after its operation (`GraphQL query Books`, `GraphQL query { books, authors }` when
// unnamed), so traffic groups by operation instead of `POST /graphql`; the operation is a span holding `parse` and
// `validate`; each of the app's own resolvers is a `function` span (`Book.author`, its path `books.3.author`), and
// what it does (a fetch(), a query) is under it. Fields without a resolver of the app's, which only read a property,
// are left out: a list of 500 objects would otherwise add thousands of spans. An exception a resolver throws comes
// back to the client in `errors` with a 200: it is the trace's error all the same. A document that didn't parse is no
// operation (`syntax error`); one that failed validation keeps its operation's name. The variables are in the
// request's body, as the app read it, their secrets masked like the rest of a body.

import { type Context, context, createContextKey, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { runtime } from "./runtime.js";

/** What tells the processor a span is GraphQL's: an operation (it has graphql.library), `parse` or `validate`. */
export const GRAPHQL = "graphql";
/** What tells the processor a span is a resolver of the app's. */
export const RESOLVER = "graphql.resolver";

const MAX_DOCUMENT = 2000;
const MAX_ROOT_FIELDS = 3;
/** What a document that didn't parse is named: it has no operation, so it groups apart from the anonymous queries. */
const SYNTAX_ERROR = "syntax error";

const tracer = trace.getTracer("tracepanel-graphql");
/** The operation running in this context: Yoga runs its phases and resolvers in it. */
const OPERATION = createContextKey("tracepanel.graphql.operation");
/** Apollo's operations by their context value: it runs the resolvers outside the operation's context. */
const byContextValue = new WeakMap<object, Operation>();
/** Errors a resolver's span recorded already: the operation leaves them be. */
const recorded = new WeakSet<object>();
const WRAPPED = Symbol.for("tracepanel.graphql.resolver");

/** The parts of graphql-js these integrations read: any version, without importing it. */
interface Node {
  kind: string;
  name?: { value: string };
  operation?: string;
  selectionSet?: { selections: readonly Node[] };
}
interface Document {
  definitions: readonly Node[];
}
interface PathEntry {
  prev: PathEntry | undefined;
  key: string | number;
}
interface ResolveInfo {
  fieldName: string;
  parentType: { name: string };
  path: PathEntry;
}
type Resolve = (source: unknown, args: unknown, contextValue: unknown, info: ResolveInfo) => unknown;
interface Field {
  resolve?: Resolve & { [WRAPPED]?: true };
}
interface NamedType {
  name: string;
  getFields?: () => Record<string, Field>;
}
interface Schema {
  getTypeMap(): Record<string, NamedType>;
}
interface GraphQLErrorLike {
  originalError?: unknown;
}

/** One operation while it runs: its span, and what the server told of it so far. */
interface Operation {
  span: Span;
  /** The context its parts run in: the operation's span current. */
  context: Context;
  library: string;
  query: string | undefined;
  operationName: string | undefined;
  /** Its parsed document; undefined while not parsed, or when it didn't parse. */
  document: Document | undefined;
  errors: readonly unknown[];
}

function begin(library: string): Operation {
  const span = tracer.startSpan("graphql operation", { attributes: { "tracepanel.span_kind": GRAPHQL } });
  return {
    span,
    context: trace.setSpan(context.active(), span),
    library,
    query: undefined,
    operationName: undefined,
    document: undefined,
    errors: [],
  };
}

/** `parse` or `validate`, a span under the operation. */
function phase(operation: Operation, name: string): Span {
  return tracer.startSpan(name, { attributes: { "tracepanel.span_kind": GRAPHQL } }, operation.context);
}

function documentText(query: string | undefined): string | null {
  if (!query) return null;
  const text = query.replace(/\s+/g, " ").trim();
  return text.length <= MAX_DOCUMENT ? text : `${text.slice(0, MAX_DOCUMENT)}…`;
}

/** `{ books, authors }`: what an unnamed operation asks for, so `{ books { id } }` isn't only "anonymous". */
function rootFields(document: Document): string | null {
  const operation = document.definitions.find((node) => node.kind === "OperationDefinition" && !node.name);
  const fields = (operation?.selectionSet?.selections ?? [])
    .filter((node) => node.kind === "Field")
    .map((node) => node.name?.value ?? "");
  if (fields.length === 0) return null;
  const more = fields.length - MAX_ROOT_FIELDS;
  return `{ ${fields.slice(0, MAX_ROOT_FIELDS).join(", ")}${more > 0 ? `, +${more}` : ""} }`;
}

/** The operation the document runs: the one named, else its only one. */
function operationOf(document: Document, name: string | undefined): Node | undefined {
  const operations = document.definitions.filter((node) => node.kind === "OperationDefinition");
  if (name) return operations.find((node) => node.name?.value === name);
  return operations.length === 1 ? operations[0] : undefined;
}

/**
 * A GraphQL error made on purpose: one the server made of the client's mistake (a syntax or validation error), or
 * one a resolver threw as its answer (`throw new GraphQLError("not found")`). Not the app's failure.
 */
function answer(error: unknown): boolean {
  for (let proto = Object.getPrototypeOf(error ?? {}); proto; proto = Object.getPrototypeOf(proto)) {
    if (proto.constructor?.name === "GraphQLError") return true;
  }
  return false;
}

/** What a resolver threw, under the GraphQLError (or two: a masked one) the server wrapped it in; else undefined. */
function thrown(error: unknown): Error | undefined {
  let at: unknown = error;
  for (let depth = 0; depth < 4 && at instanceof Error; depth++) {
    if (!answer(at)) return recorded.has(at) ? undefined : at;
    at = (at as GraphQLErrorLike).originalError;
  }
  return undefined;
}

/** Names the operation's span and the request after it; the exceptions resolvers threw are the trace's errors. */
function finish(operation: Operation): void {
  const { span, document } = operation;
  let kind: string | null = null;
  let name: string | null = null;
  let label = SYNTAX_ERROR;
  if (document) {
    // Not an operation of any type until it parses: the operationName the client sent names none either.
    const node = operationOf(document, operation.operationName);
    kind = node?.operation ?? "query";
    name = operation.operationName ?? node?.name?.value ?? null;
    label = `${kind} ${name ?? rootFields(document) ?? "anonymous"}`;
  }
  const attrs = {
    "graphql.operation.type": kind,
    "graphql.operation.name": name,
    "graphql.document": documentText(operation.query),
    "graphql.errors": operation.errors.length,
    "graphql.library": operation.library,
  };
  span.updateName(label);
  for (const [key, value] of Object.entries(attrs)) if (value !== null) span.setAttribute(key, value);
  for (const error of operation.errors) {
    // A syntax or validation error wraps nothing: the client's mistake, not the app's.
    const original = thrown(error);
    if (!original) continue;
    recorded.add(original);
    span.recordException(original);
  }
  // The request is this operation: named and grouped after it.
  runtime()?.processor.setTraceAttrs({ ...attrs, "graphql.operation": label });
  span.end();
}

function pathOf(info: ResolveInfo): string {
  const keys: string[] = [];
  for (let at: PathEntry | undefined = info.path; at; at = at.prev) keys.push(String(at.key));
  return keys.reverse().join(".");
}

function failed(span: Span, error: unknown): void {
  if (error instanceof Error && !answer(error)) {
    recorded.add(error);
    span.recordException(error);
  }
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** A resolver of the app's, run in a span of its own: what it calls (fetch(), a query) goes under it. */
function traced(field: string, resolve: Resolve): Resolve {
  const wrapped = function (this: unknown, source: unknown, args: unknown, contextValue: unknown, info: ResolveInfo) {
    const operation =
      (contextValue !== null && typeof contextValue === "object" ? byContextValue.get(contextValue) : undefined) ??
      (context.active().getValue(OPERATION) as Operation | undefined);
    if (!operation) return resolve.call(this, source, args, contextValue, info);
    const name = `${info.parentType.name}.${info.fieldName}`;
    const attributes = {
      "tracepanel.span_kind": RESOLVER,
      "graphql.field": name,
      "graphql.path": pathOf(info),
      "code.function": name,
    };
    const span = tracer.startSpan(name, { attributes }, operation.context);
    let result: unknown;
    try {
      result = context.with(trace.setSpan(operation.context, span), () =>
        resolve.call(this, source, args, contextValue, info),
      );
    } catch (error) {
      failed(span, error);
      span.end();
      throw error;
    }
    if (result !== null && typeof (result as PromiseLike<unknown>)?.then === "function") {
      return Promise.resolve(result).then(
        (value) => {
          span.end();
          return value;
        },
        (error: unknown) => {
          failed(span, error);
          span.end();
          throw error;
        },
      );
    }
    span.end();
    return result;
  } as Resolve & { [WRAPPED]?: true };
  wrapped[WRAPPED] = true;
  Object.defineProperty(wrapped, "name", { value: field });
  return wrapped;
}

const instrumented = new WeakSet<object>();

/** The app's resolvers in the schema, each in a span; once per schema. */
function instrument(schema: unknown): void {
  if (schema === null || typeof schema !== "object" || instrumented.has(schema)) return;
  instrumented.add(schema);
  for (const type of Object.values((schema as Schema).getTypeMap())) {
    if (type.name.startsWith("__") || typeof type.getFields !== "function") continue;
    for (const [name, field] of Object.entries(type.getFields())) {
      // A field without a resolver of the app's reads a property: left out.
      if (typeof field.resolve !== "function" || field.resolve[WRAPPED]) continue;
      field.resolve = traced(`${type.name}.${name}`, field.resolve);
    }
  }
}

/** Runs `wrapped` in the operation's context, and finishes the operation when it is done, however it ends. */
function within<T>(operation: Operation, wrapped: () => T): T {
  const ctx = operation.context.setValue(OPERATION, operation);
  operation.context = ctx;
  let result: T;
  try {
    result = context.with(ctx, wrapped);
  } catch (error) {
    finish(operation);
    throw error;
  }
  if (result !== null && typeof (result as PromiseLike<unknown>)?.then === "function") {
    return Promise.resolve(result).then(
      (value) => {
        finish(operation);
        return value;
      },
      (error: unknown) => {
        // The server threw what didn't parse or validate: its answer has them as errors.
        if (operation.errors.length === 0) operation.errors = [error].flat();
        finish(operation);
        throw error;
      },
    ) as T;
  }
  finish(operation);
  return result;
}

function current(): Operation | undefined {
  return context.active().getValue(OPERATION) as Operation | undefined;
}

/** A Yoga plugin's hooks this one has: Yoga's own types are the app's, not a dependency of the SDK. */
// biome-ignore lint/suspicious/noExplicitAny: the payloads are Yoga's and envelop's, of whatever version the app has.
type Hook = (payload: any) => any;

export interface YogaPlugin {
  instrumentation: { operation: (payload: unknown, wrapped: () => unknown) => unknown };
  onSchemaChange: Hook;
  onParams: Hook;
  onParse: Hook;
  onValidate: Hook;
  onExecute: Hook;
  onExecutionResult: Hook;
}

/**
 * GraphQL Yoga's plugin: `createYoga({ schema, plugins: [tracepanelYogaPlugin()] })`. Each operation is a span named after
 * it, and so is the request's trace; its parse and validate phases and the app's resolvers are spans under it.
 */
export function tracepanelYogaPlugin(): YogaPlugin {
  return {
    instrumentation: {
      operation: (_payload, wrapped) => {
        // Outside a request's trace (production, or Tracepanel off): Yoga as it is.
        if (!runtime() || !trace.getActiveSpan()) return wrapped();
        return within(begin("graphql-yoga"), wrapped);
      },
    },
    onSchemaChange: ({ schema }: { schema: unknown }) => instrument(schema),
    onParams: ({ params }: { params: { query?: string; operationName?: string } }) => {
      const operation = current();
      if (!operation) return;
      operation.query = params.query;
      operation.operationName = params.operationName ?? undefined;
    },
    onParse: () => {
      const operation = current();
      if (!operation) return undefined;
      const span = phase(operation, "parse");
      return ({ result }: { result: unknown }) => {
        if (result instanceof Error) operation.errors = [result];
        else operation.document = result as Document;
        span.end();
      };
    },
    onValidate: () => {
      const operation = current();
      if (!operation) return undefined;
      const span = phase(operation, "validate");
      return ({ valid, result }: { valid: boolean; result: readonly unknown[] }) => {
        if (!valid) operation.errors = result;
        span.end();
      };
    },
    onExecute: ({ args }: { args: { schema: unknown; document: Document; operationName?: string | null } }) => {
      // A schema set before this plugin was: its resolvers are instrumented as it first runs.
      instrument(args.schema);
      const operation = current();
      if (!operation) return;
      operation.document = args.document;
      operation.operationName = args.operationName ?? operation.operationName;
    },
    onExecutionResult: ({ result }: { result: unknown }) => {
      const operation = current();
      // A stream's result (@defer, a subscription) is its pieces: their errors come with them, not counted here.
      if (!operation || result === null || typeof result !== "object" || Array.isArray(result)) return;
      const errors = (result as { errors?: readonly unknown[] }).errors;
      if (errors) operation.errors = errors;
    },
  };
}

/** Apollo Server's request context, as far as this plugin reads it. */
interface ApolloRequest {
  schema: unknown;
  contextValue: unknown;
  request: { query?: string; operationName?: string | null };
  document?: Document;
  operationName?: string | null;
  errors?: readonly unknown[];
  response?: { body?: { kind?: string; singleResult?: { errors?: readonly unknown[] } } };
}

export interface ApolloPlugin {
  serverWillStart: (service: { schema: unknown }) => Promise<{
    schemaDidLoadOrUpdate: (schemaContext: { apiSchema: unknown }) => void;
  }>;
  // biome-ignore lint/suspicious/noExplicitAny: the request context is Apollo's, of whatever version the app has.
  requestDidStart: (requestContext: any) => Promise<object | undefined>;
}

/**
 * Apollo Server's plugin: `new ApolloServer({ typeDefs, resolvers, plugins: [tracepanelApolloPlugin()] })`. Each
 * operation is a span named after it, and so is the request's trace; its parse and validate phases and the app's
 * resolvers are spans under it.
 */
export function tracepanelApolloPlugin(): ApolloPlugin {
  return {
    serverWillStart: async ({ schema }) => {
      instrument(schema);
      return { schemaDidLoadOrUpdate: ({ apiSchema }) => instrument(apiSchema) };
    },
    requestDidStart: async (requestContext: ApolloRequest) => {
      if (!runtime() || !trace.getActiveSpan()) return undefined;
      instrument(requestContext.schema);
      const operation = begin("apollo-server");
      operation.context = operation.context.setValue(OPERATION, operation);
      operation.query = requestContext.request.query;
      operation.operationName = requestContext.request.operationName ?? undefined;
      const { contextValue } = requestContext;
      if (contextValue !== null && typeof contextValue === "object") byContextValue.set(contextValue, operation);
      return {
        parsingDidStart: async () => {
          const span = phase(operation, "parse");
          return async () => span.end();
        },
        validationDidStart: async () => {
          const span = phase(operation, "validate");
          return async () => span.end();
        },
        didResolveOperation: async (resolved: ApolloRequest) => {
          operation.operationName = resolved.operationName ?? operation.operationName;
        },
        willSendResponse: async (done: ApolloRequest) => {
          operation.document = done.document;
          const body = done.response?.body;
          operation.errors = done.errors ?? (body?.kind === "single" ? body.singleResult?.errors : undefined) ?? [];
          finish(operation);
        },
      };
    },
  };
}
