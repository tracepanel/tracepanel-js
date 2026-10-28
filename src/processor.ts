// The span processor: the app traces itself with OpenTelemetry (its HTTP server, Express, its database driver), and
// each request's spans become one Tracepanel trace, sent to the agent when the request's span ends.

import { createHash } from "node:crypto";
import { type Context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TaskEvent } from "./agent.js";
import { awsCall, isAws } from "./aws.js";
import { httpCall, isMongo, isRedis, mongoCall, redisCall } from "./calls.js";
import type { Config } from "./config.js";
import { CALL_ORIGIN } from "./fetch.js";
import { withVersion } from "./frameworks.js";
import { GRAPHQL, RESOLVER } from "./graphql.js";
import { ANTHROPIC_SCOPE, KIND as LLM } from "./llm.js";
import { Locals } from "./locals.js";
import {
  type Attrs,
  countDropped,
  type Log,
  limited,
  MAX_LOGS,
  micros,
  newId,
  type Span,
  type Trace,
} from "./model.js";
import { ASKED, ATTRIBUTE, asking, available, Profiler, type Recording, wanted } from "./profile.js";
import { QUERY_ORIGIN, type QueryOrigin } from "./queries.js";
import { fingerprint, spanName, statement } from "./sql.js";
import { frames, madeAt } from "./stack.js";
import { CONTROL } from "./transactions.js";
import { VIEW } from "./view.js";

/** Where a trace goes once its request ends. */
export interface Sink {
  submit(trace: Trace): void;
  /** A task event to the agent, where the sink sends them (a test's collector may not). */
  submitEvent?(event: TaskEvent): void;
}

/** The kinds of work a trace() or an integration starts a trace of: tracepanel.kind on its root span. */
const WORK = new Set(["command", "task", "test"]);

/** One request's trace while its spans end. */
interface Building {
  trace: Trace;
  /** OTel span id: the Tracepanel span id it is, or its nearest kept ancestor's when it is left out. */
  ids: Map<string, string | null>;
  origins: Map<string, string | null>;
  /** OTel span id: the library code that asked for a call none of the app's code was on the stack of. */
  callers: Map<string, string>;
  /** The ORM a span's call went through (db.client), by the span's id. */
  orms: Map<string, string>;
  queries: number;
  dbTime: number;
  framework: string;
  /** performance.now() as the request's root span started. */
  startedMs: number;
  /** OTel span id of the request's root span here: its parent, if any, is in another process. */
  rootSpanId: string;
  /** The W3C trace id the root span has: a test's, for the requests the test made of the app. */
  traceId: string;
  /** The route pattern a framework named (Nitro's /api/books/:id), for a root span that has none. */
  route: string | null;
  /** The request as its root span started: method and target, to find it from a response sent outside its context. */
  request: string;
  /** Whether a response's headers have taken this trace's id already. */
  answered: boolean;
  /** Tracepanel ids of Nest controller spans: the exceptions they record may be HTTP answers, not errors. */
  nestViews: Set<string>;
  /** OTel span id: the Tracepanel id of the span's parent when it started. */
  parents: Map<string, string | null>;
  /** Express's anonymous route handlers that a Nest controller's span stands in for: left out, children and all. */
  replaced: Set<string>;
  /** OTel span id: the Express route handlers' ones, so a Nest span under one can take its place. */
  expressHandlers: Set<string>;
  /** OTel span ids of transaction and savepoint spans. */
  transactions: Set<string>;
  /** OTel span id → the app's line behind a span that is left out, for the span it stands over (Next's fetch). */
  passedOrigins: Map<string, string | null>;
  /** OTel span id of a span left out → its parent's, and whether it is an ORM's transaction (Prisma's $transaction). */
  skippedParents: Map<string, { parent: string; ormTransaction: boolean }>;
  /** OTel span id → the Tracepanel id of its parent, where it isn't its OTel parent's (a transaction an ORM began). */
  fixedParents: Map<string, string | null>;
  /**
   * The app's line behind the latest span that had one. A driver often starts its query span later, from a callback
   * (pg's pool runs the query once it has a connection), where the stack holds none of the app's code; the
   * connection checkout before it started right in the app's call.
   */
  lastOrigin: string | null;
  /** The ORM the app's last call went through, with lastOrigin. */
  lastOrm: string | null;
  /** The trace's profile while it runs, when it is profiled. */
  recording?: Recording | undefined;
}

// A request's span can end after the response does (Express ends an async handler's span when its promise settles):
// the trace goes out this long after the request's span ends, with the spans that ended meanwhile.
const LATE_SPANS_MS = 25;
// A request whose root span never ends (the client went away mid-stream and the framework didn't end it) is dropped
// after this long, so the open traces don't grow for ever.
const ABANDONED_MS = 10 * 60 * 1000;

// What serves a request, below the framework that answers it.
const SERVERS = new Set(["node:http", "Bun.serve"]);
// Spans that are bookkeeping, not work: Express's middleware and routers, a driver's connection checkouts, and
// Nest's inner handler span (the same call as its request context span, which names the controller).
const SKIPPED_EXPRESS = new Set(["middleware", "router"]);
const SKIPPED_NEST = new Set(["handler", "app_creation"]);
// Next.js's own bookkeeping: finding and loading the route's modules, the first byte, metadata.
const SKIPPED_NEXT = new Set([
  "NextNodeServer.findPageComponents",
  "NextNodeServer.getLayoutOrPageModule",
  "NextNodeServer.startResponse",
  "NextNodeServer.clientComponentLoading",
  "NextNodeServer.createComponentTree",
  "LoadComponents.loadRouteModule",
  "RouteModule.prepare",
  "ResolveMetadata.generateMetadata",
  // Next's own span of a fetch(): undici's under it is the call, with the traceparent the callee got.
  "AppRender.fetch",
]);
// What runs a Next.js route: an app or pages render, a route handler, getServerSideProps.
const NEXT_HANDLERS = new Set([
  "AppRender.getBodyResult",
  "AppRouteRouteHandlers.runHandler",
  "Render.getServerSideProps",
  "Render.renderDocument",
]);
// Requests that aren't the app's work: Next.js's for its own assets and dev tooling, and the ones to Tracepanel's
// console on the app's own origin (the widget, the page's recording sending its traces).
const INTERNAL = /^\/(_next|__nextjs|__tracepanel__\/)/;
// Prisma's span of an interactive transaction, $transaction(async (tx) => ...): the app's callback runs in its context.
const ORM_TRANSACTIONS = new Set(["prisma:client:transaction"]);
// Prisma's own spans besides the operation: its SQL goes through the driver adapter's driver (pg, mysql2), recorded
// there; the rest is its query engine's bookkeeping.
const SKIPPED_NAMES = /^(pg\.connect|pg-pool\.connect|mysql2?\.connect|prisma:(?!client:operation$))/;

function attrsOf(span: ReadableSpan | SdkSpan): Attrs {
  return { ...(span as ReadableSpan).attributes };
}

function first(attrs: Attrs, ...keys: string[]): unknown {
  for (const key of keys) {
    if (attrs[key] !== undefined) return attrs[key];
  }
  return undefined;
}

function durationUs(span: ReadableSpan): number {
  const [seconds, nanos] = span.duration;
  return Math.round(seconds * 1e6 + nanos / 1e3);
}

function startUs(span: ReadableSpan): number {
  const [seconds, nanos] = span.startTime;
  return Math.round(seconds * 1e6 + nanos / 1e3);
}

function skipped(span: ReadableSpan | SdkSpan): boolean {
  const attrs = attrsOf(span);
  return (
    SKIPPED_EXPRESS.has(String(attrs["express.type"])) ||
    SKIPPED_NEST.has(String(attrs["nestjs.type"])) ||
    SKIPPED_NEXT.has(String(attrs["next.span_type"])) ||
    SKIPPED_NAMES.test(span.name) ||
    // Anthropic's SDK's own span of a call: the LLM call's span (llm.ts) is the call.
    (span as ReadableSpan).instrumentationScope?.name.startsWith(ANTHROPIC_SCOPE) === true
  );
}

/** A value an instrumentation kept as JSON (an attribute holds no objects); undefined when there is none. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function statementOf(attrs: Attrs): string {
  const text = first(attrs, "db.query.text", "db.statement");
  return typeof text === "string" ? text : "";
}

export class TracepanelProcessor implements SpanProcessor {
  /** The traces being built, by their root span's OTel id. */
  private readonly open = new Map<string, Building>();
  /**
   * OTel span id → the trace it belongs to. Not the OTel trace id: a request the app makes to itself (fetch to its own
   * API) carries the caller's trace id, and is a trace of its own all the same.
   */
  private readonly owner = new Map<string, Building>();
  private readonly profiler: Profiler | undefined;
  /** What reads an error's local variables: made as the first trace starts; null where it can't be. */
  private locals: Locals | null | undefined;

  constructor(
    private readonly config: Config,
    /** Where the traces go: a test runner's integration puts its own in front of the agent's (testing.ts). */
    public sink: Sink,
  ) {
    this.profiler =
      config.profileEnabled && available() ? new Profiler(config.root, config.profileIntervalMs) : undefined;
  }

  onStart(span: SdkSpan, parentContext: Context): void {
    const context = span.spanContext();
    const parent = span.parentSpanContext;
    let building = parent ? this.owner.get(parent.spanId) : undefined;
    // A request that came with a traceparent (from another app, or this one calling itself) starts a trace here.
    const local = !parent || (parent.isRemote === true && span.kind === SpanKind.SERVER);
    if (local) {
      // A request, or work outside one that trace() or a task queue started: tracepanel.kind says which.
      const kind = attrsOf(span)["tracepanel.kind"];
      if (span.kind !== SpanKind.SERVER && !WORK.has(String(kind))) return;
      if (INTERNAL.test(String(first(attrsOf(span), "http.target", "url.path") ?? ""))) return;
      this.dropAbandoned();
      building = this.start();
      if (kind === "command" || kind === "task" || kind === "test") building.trace.kind = kind;
      building.rootSpanId = context.spanId;
      building.traceId = context.traceId;
      const rootAttrs = attrsOf(span);
      building.request = requestKey(
        first(rootAttrs, "http.request.method", "http.method"),
        first(rootAttrs, "http.target", "url.path"),
      );
      this.open.set(context.spanId, building);
      this.running();
      this.profiler?.enter(building);
      // The request asked for it: its root span says so (Node's HTTP server, Bun.serve), or the context the framework
      // started it in (Next.js).
      const asked = asking(rootAttrs[ATTRIBUTE]) ?? asking(parentContext.getValue(ASKED));
      const mode = this.profiler ? wanted(this.config, asked) : undefined;
      if (mode) building.recording = this.profiler?.start(building, mode === "memory");
    }
    if (!building) return;
    this.owner.set(context.spanId, building);
    const attrs = attrsOf(span);
    const here = madeAt(this.config.root);
    // A query whose stack has none of the app's code (Bun's, no async frames) was made where the app last called its
    // ORM, in this context (queries.ts).
    const query = here.origin || !first(attrs, "db.system.name", "db.system") ? undefined : queryOrigin(parentContext);
    const found = here.origin ?? query?.origin ?? null;
    const ormHere = here.orm ?? query?.orm ?? null;
    // A driver's call made in a callback (pg-pool's query, once it has a connection) has neither the app's frames nor
    // its ORM's on the stack: it went through the ORM of the app's last call, as it was made where that one was.
    const orm = found ? ormHere : (ormHere ?? building.lastOrm);
    if (found) {
      building.lastOrigin = found;
      building.lastOrm = ormHere;
    }
    if (here.caller && !found) building.callers.set(context.spanId, here.caller);
    if (orm) building.orms.set(context.spanId, orm);
    if (!local && parent && skipped(span)) {
      building.ids.set(context.spanId, building.ids.get(parent.spanId) ?? null);
      building.passedOrigins.set(context.spanId, found ?? building.passedOrigins.get(parent.spanId) ?? null);
      building.skippedParents.set(context.spanId, {
        parent: parent.spanId,
        ormTransaction: ORM_TRANSACTIONS.has(span.name),
      });
      return;
    }
    if (attrs["tracepanel.span_kind"] === "transaction") building.transactions.add(context.spanId);
    if (attrs["express.type"] === "request_handler") building.expressHandlers.add(context.spanId);
    if (parent && attrs["nestjs.type"] === "request_context" && building.expressHandlers.has(parent.spanId)) {
      // Nest's router is Express's route handler: the controller's span takes its place in the tree.
      building.replaced.add(parent.spanId);
      building.ids.set(parent.spanId, building.parents.get(parent.spanId) ?? null);
      building.framework = "NestJS";
    }
    building.parents.set(context.spanId, parent && !local ? (building.ids.get(parent.spanId) ?? null) : null);
    if (!parent && attrs["next.span_type"] === "BaseServer.handleRequest") building.framework = "Next.js";
    building.ids.set(context.spanId, newId());
    if (parent && building.transactions.has(context.spanId)) this.adopt(building, parent.spanId, context.spanId);
    // A span started outside the app's code (undici's, under Next's fetch span) is the call the app made there.
    // So is one a call made from its context, which took the app's line as the app called it (fetch()).
    const passed =
      (parent ? building.passedOrigins.get(parent.spanId) : undefined) ??
      (parentContext.getValue(CALL_ORIGIN) as string | undefined);
    building.origins.set(context.spanId, found ?? passed ?? building.lastOrigin);
  }

  /**
   * A transaction an ORM began from its own span (Prisma's interactive $transaction: BEGIN is sent from its engine,
   * under its prisma:client:transaction span, while the app's callback runs in that span's context): what the callback
   * does (its queries, HTTP calls, jobs) goes inside the transaction span, as it does when the app sends BEGIN itself.
   */
  private adopt(building: Building, parentSpanId: string, spanId: string): void {
    let at: string | undefined = parentSpanId;
    while (at !== undefined) {
      const skippedSpan = building.skippedParents.get(at);
      if (!skippedSpan) return;
      if (skippedSpan.ormTransaction) {
        building.fixedParents.set(spanId, building.ids.get(parentSpanId) ?? null);
        building.ids.set(at, building.ids.get(spanId) ?? null);
        skippedSpan.ormTransaction = false;
        return;
      }
      at = skippedSpan.parent;
    }
  }

  onEnd(span: ReadableSpan): void {
    if (process.env.TRACEPANEL_DEBUG) {
      process.stderr.write(
        `[tracepanel] ${span.name} kind=${span.kind} parent=${span.parentSpanContext?.spanId ?? "-"} ${JSON.stringify(span.attributes)}\n`,
      );
    }
    const context = span.spanContext();
    const building = this.owner.get(context.spanId);
    if (!building) return;
    const root = context.spanId === building.rootSpanId;
    if (building.replaced.has(context.spanId)) return;
    if (root || !(skipped(span) || this.control(building, span))) this.convert(building, span, root);
    if (!root) return;
    const sampled = building.recording ? this.profiler?.stop(building.recording) : undefined;
    this.profiler?.leave(building);
    setTimeout(() => {
      this.close(building);
      this.finish(building, span);
      if (sampled?.profile) {
        building.trace.profile = sampled.profile;
        const gc = sampled.gc?.();
        if (gc) sampled.profile.gc = gc;
      }
      if (sampled?.dropped) countDropped(building.trace, "tracepanel.dropped_samples", sampled.dropped);
      this.sink.submit(limited(building.trace));
    }, LATE_SPANS_MS).unref();
  }

  /**
   * BEGIN, COMMIT and the like in a transaction span, which stands for them. Told as the span ends: the pg
   * instrumentation sets the statement after it starts.
   */
  private control(building: Building, span: ReadableSpan): boolean {
    const parent = span.parentSpanContext?.spanId;
    return parent !== undefined && building.transactions.has(parent) && CONTROL.test(statementOf(attrsOf(span)));
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** A task event to the agent: a queue's job in flight, or a worker's heartbeat (bullmq.ts). */
  taskEvent(event: TaskEvent): void {
    this.sink.submitEvent?.(event);
  }

  /** The trace being built for the active request, with the current span's Tracepanel id. */
  current(): { building: Building; spanId: string | null } | undefined {
    const span = trace.getActiveSpan();
    if (!span) return undefined;
    const context = span.spanContext();
    const building = this.owner.get(context.spanId);
    return building ? { building, spanId: building.ids.get(context.spanId) ?? null } : undefined;
  }

  /** The trace being built from an OTel span, while it is: a test's, its spans so far. */
  openTrace(spanId: string): Trace | undefined {
    return this.owner.get(spanId)?.trace;
  }

  /**
   * The traces of this W3C trace id still being built, or waiting for their late spans: the requests a test made of
   * the app, their traces not yet sent. `except`: the OTel id of a root span left out (the test's own, running).
   */
  building(traceId: string, except?: string): Trace[] {
    return [...this.open.values()]
      .filter((building) => building.traceId === traceId && building.rootSpanId !== except)
      .map((building) => building.trace);
  }

  /** What the widget shows before the request's span ends: its id, its queries so far and their time. */
  timing(request?: { method: string; url: string }): Timing | undefined {
    const building = this.current()?.building ?? (request ? this.waiting(request) : undefined);
    if (!building) return undefined;
    // A response's headers took it: another response to the same URL is another request's.
    if (request) building.answered = true;
    return {
      id: building.trace.id,
      name: nameOf(building.trace),
      queries: building.queries,
      dbMs: building.dbTime / 1000,
      startedMs: building.startedMs,
    };
  }

  private dropAbandoned(): void {
    const oldest = performance.now() - ABANDONED_MS;
    for (const building of [...this.open.values()]) {
      if (building.startedMs < oldest) this.close(building);
    }
  }

  /** The trace is done here: its spans no longer lead to it. */
  private close(building: Building): void {
    this.open.delete(building.rootSpanId);
    for (const spanId of building.ids.keys()) this.owner.delete(spanId);
    // One whose root span never ended.
    if (building.recording) this.profiler?.stop(building.recording);
    this.profiler?.leave(building);
    this.running();
  }

  /** Whether a trace runs, for the errors' local variables: errors are read only then. */
  private running(): void {
    const running = this.open.size > 0;
    if (running && this.locals === undefined && this.config.captureLocals) {
      this.locals = Locals.start(this.config.root, () => this.current()?.building.trace.id) ?? null;
    }
    this.locals?.traces(running);
  }

  /**
   * The open trace of a request whose response goes out outside its context (Next.js streams a page from another
   * async context): the latest one for this method and URL that no response has answered yet.
   */
  private waiting(request: { method: string; url: string }): Building | undefined {
    const key = requestKey(request.method, request.url);
    let found: Building | undefined;
    for (const building of this.open.values()) {
      if (building.request === key && !building.answered) found = building;
    }
    return found;
  }

  /** An error a framework caught and answered with a 500 itself, without recording it on a span (Nitro). */
  addError(error: unknown): void {
    const current = this.current();
    if (!current) return;
    const thrown = error instanceof Error ? error : new Error(String(error));
    // h3 wraps what the handler threw: the cause is the app's error.
    const cause = thrown.cause instanceof Error ? thrown.cause : thrown;
    current.building.trace.errors.push({
      span_id: current.spanId,
      time: Date.now() * 1000,
      type: cause.name || "Error",
      message: cause.message,
      handled: false,
      frames: frames(cause.stack ?? "", this.config.root, this.locals?.take(cause.stack)),
      chain: [],
    });
  }

  addLog(log: Omit<Log, "span_id">): void {
    const current = this.current();
    if (!current) return;
    const { trace } = current.building;
    if (trace.logs.length >= MAX_LOGS) countDropped(trace, "tracepanel.dropped_logs");
    else trace.logs.push({ ...log, span_id: current.spanId });
  }

  /**
   * The framework the active request runs on, unless a more specific one (Nest on Express) already said so. A server
   * (Node's, Bun.serve) gives way to the framework on it (Hono).
   */
  setFramework(name: string): void {
    const current = this.current();
    if (current && SERVERS.has(current.building.framework)) current.building.framework = name;
  }

  /** The route pattern the framework matched, when the root span doesn't carry one (Nitro). */
  setRoute(route: string): void {
    const current = this.current();
    if (current) current.building.route = route;
  }

  /**
   * Attributes of the active request's trace: the signed-in user (setUser()), what the request carried. `request`
   * finds it when its response goes out outside its context, as timing() does.
   */
  setTraceAttrs(attrs: Attrs, request?: { method: string; url: string }): void {
    const building = this.current()?.building ?? (request ? this.waiting(request) : undefined);
    if (building) Object.assign(building.trace.attrs, attrs);
  }

  /** The framework the active request ran on, as the panel shows it. */
  framework(): string | undefined {
    return this.current()?.building.framework;
  }

  private start(): Building {
    return {
      trace: {
        id: newId(),
        kind: "http",
        name: "",
        start: 0,
        duration: 0,
        status: "ok",
        attrs: {},
        spans: [],
        logs: [],
        errors: [],
        links: [],
        issues: [],
      },
      ids: new Map(),
      origins: new Map(),
      callers: new Map(),
      orms: new Map(),
      queries: 0,
      dbTime: 0,
      framework: "node:http",
      startedMs: performance.now(),
      rootSpanId: "",
      traceId: "",
      route: null,
      request: "",
      answered: false,
      replaced: new Set(),
      nestViews: new Set(),
      expressHandlers: new Set(),
      transactions: new Set(),
      passedOrigins: new Map(),
      skippedParents: new Map(),
      fixedParents: new Map(),
      parents: new Map(),
      lastOrigin: null,
      lastOrm: null,
    };
  }

  /** A span as Tracepanel draws it: the request, a route handler (view), a statement (sql), an outgoing call. */
  private convert(building: Building, span: ReadableSpan, root: boolean): void {
    const context = span.spanContext();
    const id = building.ids.get(context.spanId);
    if (!id) return;
    const parentId = root
      ? null
      : building.fixedParents.has(context.spanId)
        ? (building.fixedParents.get(context.spanId) ?? null)
        : (building.ids.get(span.parentSpanContext?.spanId ?? "") ?? null);
    if (!root && parentId === null) return;
    const attrs = attrsOf(span);
    const converted: Span = {
      id,
      parent_id: parentId,
      kind: "function",
      name: span.name,
      start: startUs(span),
      duration: durationUs(span),
      status: span.status.code === SpanStatusCode.ERROR ? "error" : "ok",
      attrs: {},
    };
    const codeOrigin = building.origins.get(context.spanId) ?? null;
    // A database call none of the app's code made: the library code that asked for it, as the Python SDK records it.
    const caller = building.callers.get(context.spanId);
    const asked = codeOrigin === null && caller ? { "code.caller": caller } : {};
    const orm = building.orms.get(context.spanId);
    const sql = isRedis(attrs) || isMongo(attrs) ? "" : statementOf(attrs);
    if (root) {
      converted.kind = { http: "http", task: "task.run", command: "command", test: "function" }[building.trace.kind];
    } else if (attrs["express.type"] === "request_handler") {
      converted.kind = "view";
      converted.name = String(attrs["express.name"] ?? span.name);
      building.trace.attrs["code.view"] = converted.name;
    } else if (attrs["tracepanel.span_kind"] === VIEW) {
      // A route's handler in Fastify, Koa or Hono (view.ts): named by its route, where the app added it if known.
      converted.kind = "view";
      converted.name = String(attrs["code.view"] ?? span.name);
      converted.attrs = attrs["code.origin"] ? { "code.origin": attrs["code.origin"] } : {};
      building.trace.attrs["code.view"] = converted.name;
    } else if (NEXT_HANDLERS.has(String(attrs["next.span_type"]))) {
      converted.kind = "view";
      converted.name = String(first(attrs, "next.route", "next.page") ?? span.name);
      building.trace.attrs["code.view"] = converted.name;
    } else if (attrs["nestjs.type"] === "request_context") {
      converted.kind = "view";
      converted.name = `${attrs["nestjs.controller"] ?? "Controller"}.${attrs["nestjs.callback"] ?? span.name}`;
      building.trace.attrs["code.view"] = converted.name;
      building.nestViews.add(id);
    } else if (attrs["tracepanel.span_kind"] === GRAPHQL) {
      // A GraphQL operation (graphql.ts), named after it, or its parse or validate phase.
      converted.kind = "graphql";
      converted.attrs =
        attrs["graphql.library"] === undefined
          ? {}
          : {
              "graphql.operation.type": attrs["graphql.operation.type"] ?? null,
              "graphql.operation.name": attrs["graphql.operation.name"] ?? null,
              "graphql.document": attrs["graphql.document"] ?? null,
              "graphql.errors": attrs["graphql.errors"] ?? 0,
              "graphql.library": attrs["graphql.library"],
            };
    } else if (attrs["tracepanel.span_kind"] === RESOLVER) {
      // A resolver of the app's: what it called is under it.
      converted.attrs = {
        "graphql.field": attrs["graphql.field"],
        "graphql.path": attrs["graphql.path"],
        "code.function": attrs["code.function"],
      };
    } else if (attrs["tracepanel.span_kind"] === "task.enqueue") {
      converted.kind = "task.enqueue";
      converted.name = String(attrs["task.name"] ?? span.name);
      converted.attrs = {
        ...Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("task."))),
        "code.origin": codeOrigin,
      };
    } else if (attrs["tracepanel.span_kind"] === "transaction") {
      converted.kind = "transaction";
      const { "tracepanel.span_kind": _, ...own } = attrs;
      // Begun through an ORM (Prisma's $transaction, Drizzle's db.transaction()): db.client names it, as a query's does.
      converted.attrs = { ...own, ...(orm ? { "db.client": orm } : {}), "code.origin": codeOrigin, ...asked };
    } else if (attrs["tracepanel.span_kind"] === LLM) {
      converted.kind = LLM;
      const { "tracepanel.span_kind": _, ...own } = attrs;
      converted.attrs = { ...own, "code.origin": codeOrigin };
    } else if (isAws(attrs)) {
      const call = awsCall(attrs);
      converted.kind = call.kind;
      converted.name = call.name;
      converted.attrs = { ...call.attrs, "code.origin": codeOrigin };
    } else if (isRedis(attrs)) {
      const call = redisCall(attrs, span.name);
      converted.kind = "redis";
      converted.name = call.name;
      converted.attrs = { ...call.attrs, "code.origin": codeOrigin, ...asked };
    } else if (isMongo(attrs)) {
      const call = mongoCall(attrs, span.name);
      converted.kind = "mongodb";
      converted.name = call.name;
      converted.attrs = { ...call.attrs, ...(orm ? { "db.client": orm } : {}), "code.origin": codeOrigin, ...asked };
    } else if (span.name === "prisma:client:operation") {
      converted.name = `prisma ${attrs.model ? `${attrs.model}.` : ""}${attrs.method ?? "operation"}`;
      converted.attrs = { "code.origin": codeOrigin, ...asked };
    } else if (sql) {
      converted.kind = "sql";
      converted.name = spanName(sql);
      converted.attrs = { ...this.sqlAttrs(attrs, sql, codeOrigin, orm), ...asked };
      building.queries += 1;
      building.dbTime += converted.duration;
    } else if (span.kind === SpanKind.CLIENT && first(attrs, "http.request.method", "http.method")) {
      const call = httpCall(attrs);
      converted.kind = "http.client";
      converted.name = call.name;
      // The traceparent the call carried names this span: the agent links the callee's trace to it.
      converted.attrs = { ...call.attrs, "w3c.span_id": context.spanId, "code.origin": codeOrigin };
    } else {
      converted.attrs = { ...attrs, "code.origin": codeOrigin };
    }
    building.trace.spans.push(converted);
    this.collectErrors(building, span, id);
  }

  /** A statement's attributes. `orm`: the ORM it went through, which db.client names instead of the driver. */
  private sqlAttrs(attrs: Attrs, sql: string, codeOrigin: string | null, orm?: string): Attrs {
    const system = String(first(attrs, "db.system.name", "db.system") ?? "");
    // pg reports the parameters with enhancedDatabaseReporting: the same statement with the same values is a
    // duplicate, the same statement with other values an N+1 candidate. SQLite's (sqlite.ts) come as JSON.
    const values = first(attrs, "db.postgresql.values", "db.query.parameter") ?? parsed(attrs["tracepanel.db.params"]);
    // What EXPLAIN binds back: pg's values, SQLite's; mysql2 writes them into the statement itself.
    const params = Array.isArray(values) ? values : system === "mysql" ? [] : undefined;
    const driver = attrs["tracepanel.db.client"];
    const namespace = attrs["db.namespace"];
    const rows = attrs["db.response.returned_rows"];
    return {
      ...(params ? { "db.params": params } : {}),
      "db.client": orm ?? (typeof driver === "string" ? driver : system === "postgresql" ? "pg" : system),
      "db.system": system,
      "db.vendor": system,
      "db.alias": "default",
      ...(system === "sqlite" && typeof namespace === "string" ? { "db.namespace": namespace } : {}),
      ...(typeof rows === "number" ? { "db.response.returned_rows": rows } : {}),
      "db.statement": statement(sql),
      "db.fingerprint": fingerprint(sql),
      "db.params_hash":
        values === undefined ? null : createHash("sha1").update(JSON.stringify(values)).digest("hex").slice(0, 12),
      "db.many": false,
      "code.origin": codeOrigin,
    };
  }

  /** Exceptions the instrumentation recorded on a span: the request's errors, with their frames. */
  private collectErrors(building: Building, span: ReadableSpan, spanId: string): void {
    for (const event of span.events) {
      if (event.name !== "exception") continue;
      const attrs = event.attributes ?? {};
      const [seconds, nanos] = event.time;
      const stack = String(attrs["exception.stacktrace"] ?? "");
      building.trace.errors.push({
        span_id: spanId,
        time: Math.round(seconds * 1e6 + nanos / 1e3),
        type: String(attrs["exception.type"] ?? "Error"),
        message: String(attrs["exception.message"] ?? ""),
        handled: false,
        frames: frames(stack, this.config.root, this.locals?.take(stack)),
        chain: [],
      });
    }
  }

  /** The trace from its root span: name, timing, the request's attributes. */
  private finish(building: Building, root: ReadableSpan): void {
    if (building.trace.kind !== "http") {
      this.finishWork(building, root);
      return;
    }
    const attrs = attrsOf(root);
    const method = String(first(attrs, "http.request.method", "http.method") ?? "GET");
    const path = String(first(attrs, "url.path", "http.target") ?? "/").split("?")[0];
    const route = first(attrs, "http.route", "next.route") ?? building.route;
    const status = Number(first(attrs, "http.response.status_code", "http.status_code") ?? 0);
    const tr = building.trace;
    if (status > 0 && status < 500) {
      // Nest throws NotFoundException and the like to answer 404, 422…: an answer, not an error.
      tr.errors = tr.errors.filter((error) => !building.nestViews.has(error.span_id ?? ""));
    }
    tr.name = nameOf(tr) ?? `${method} ${typeof route === "string" && route ? route : path}`;
    tr.start = startUs(root);
    tr.duration = durationUs(root);
    if (status >= 500 || root.status.code === SpanStatusCode.ERROR || tr.errors.length > 0) tr.status = "error";
    const rootSpan = tr.spans.find((span) => span.parent_id === null);
    if (rootSpan) rootSpan.name = tr.name;
    tr.attrs = {
      ...tr.attrs,
      "http.method": method,
      "http.path": path,
      "http.route": typeof route === "string" ? route : null,
      "http.status_code": status,
      "service.name": this.config.service,
      "service.role": "web",
      "telemetry.sdk.language": "nodejs",
      "process.runtime.name": process.versions.bun ? "bun" : "node",
      "process.runtime.version": process.versions.bun ?? process.versions.node,
      "tracepanel.framework": withVersion(building.framework),
      // The W3C ids: the agent links this trace to the one that called it, in another app or process.
      "w3c.trace_id": root.spanContext().traceId,
    };
    if (root.parentSpanContext?.isRemote) tr.attrs["w3c.parent_span_id"] = root.parentSpanContext.spanId;
  }

  /**
   * A command (trace()), a task (a queue's job) or a test: named as it was started, its task.* attributes kept (a
   * test's test.* and code.*: which test, where).
   */
  private finishWork(building: Building, root: ReadableSpan): void {
    const attrs = attrsOf(root);
    const tr = building.trace;
    tr.name = String(attrs["tracepanel.name"] ?? root.name);
    tr.start = startUs(root);
    tr.duration = durationUs(root);
    if (root.status.code === SpanStatusCode.ERROR || tr.errors.length > 0) tr.status = "error";
    const rootSpan = tr.spans.find((span) => span.parent_id === null);
    if (rootSpan) {
      rootSpan.name = tr.name;
      rootSpan.attrs = {};
    }
    const kept = tr.kind === "test" ? /^(test|code)\./ : /^task\./;
    const own = Object.fromEntries(Object.entries(attrs).filter(([key]) => kept.test(key)));
    tr.attrs = {
      ...tr.attrs,
      ...own,
      "service.name": this.config.service,
      "service.role": tr.kind === "task" ? "worker" : tr.kind === "test" ? "test" : "command",
      "telemetry.sdk.language": "nodejs",
      "process.runtime.name": process.versions.bun ? "bun" : "node",
      "process.runtime.version": process.versions.bun ?? process.versions.node,
      "w3c.trace_id": root.spanContext().traceId,
    };
  }
}

export interface Timing {
  id: string;
  /** The trace's name when it says more than the request line: a GraphQL operation's. */
  name?: string | undefined;
  queries: number;
  dbMs: number;
  /** performance.now() as the request started. */
  startedMs: number;
}

/** A GraphQL request's name: one URL serves every operation, so the operation names it (`GraphQL query Books`). */
function nameOf(trace: Trace): string | undefined {
  const operation = trace.attrs["graphql.operation"];
  return typeof operation === "string" ? `GraphQL ${operation}` : undefined;
}

function queryOrigin(parentContext: Context): QueryOrigin | undefined {
  return parentContext.getValue(QUERY_ORIGIN) as QueryOrigin | undefined;
}

function requestKey(method: unknown, target: unknown): string {
  return `${String(method ?? "GET").toUpperCase()} ${String(target ?? "/")}`;
}

/** `Node 26 · Express`: what the panel shows next to its logo. */
export function runtimeLabel(framework: string): string {
  const bun = process.versions.bun;
  const named = withVersion(framework, 2);
  if (bun) return `Bun ${bun.split(".").slice(0, 2).join(".")} · ${named}`;
  return `Node ${process.versions.node.split(".")[0]} · ${named}`;
}

export { micros };
