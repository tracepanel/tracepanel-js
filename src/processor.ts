// The span processor: the app traces itself with OpenTelemetry (its HTTP server, Express, its database driver), and
// each request's spans become one Tracepanel trace, sent to the agent when the request's span ends.

import { createHash } from "node:crypto";
import { type Context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Config } from "./config.js";
import { type Attrs, type Log, micros, newId, type Span, type Trace } from "./model.js";
import { fingerprint, spanName, statement } from "./sql.js";
import { frames, origin } from "./stack.js";

/** Where a trace goes once its request ends. */
export interface Sink {
  submit(trace: Trace): void;
}

/** One request's trace while its spans end. */
interface Building {
  trace: Trace;
  /** OTel span id: the Tracepanel span id it is, or its nearest kept ancestor's when it is left out. */
  ids: Map<string, string | null>;
  origins: Map<string, string | null>;
  queries: number;
  dbTime: number;
  framework: string;
  /** performance.now() as the request's root span started. */
  startedMs: number;
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
  /**
   * The app's line behind the latest span that had one. A driver often starts its query span later, from a callback
   * (pg's pool runs the query once it has a connection), where the stack holds none of the app's code; the
   * connection checkout before it started right in the app's call.
   */
  lastOrigin: string | null;
}

// A request's span can end after the response does (Express ends an async handler's span when its promise settles):
// the trace goes out this long after the request's span ends, with the spans that ended meanwhile.
const LATE_SPANS_MS = 25;
// A request whose root span never ends (the client went away mid-stream and the framework didn't end it) is dropped
// after this long, so the open traces don't grow for ever.
const ABANDONED_MS = 10 * 60 * 1000;

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
]);
// What runs a Next.js route: an app or pages render, a route handler, getServerSideProps.
const NEXT_HANDLERS = new Set([
  "AppRender.getBodyResult",
  "AppRouteRouteHandlers.runHandler",
  "Render.getServerSideProps",
  "Render.renderDocument",
]);
// Next.js's requests for its own assets and dev tooling, not the app's.
const NEXT_INTERNAL = /^\/(_next|__nextjs)/;
const SKIPPED_NAMES = /^(pg\.connect|pg-pool\.connect|mysql2?\.connect)/;

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
    SKIPPED_NAMES.test(span.name)
  );
}

function statementOf(attrs: Attrs): string {
  const text = first(attrs, "db.query.text", "db.statement");
  return typeof text === "string" ? text : "";
}

export class TracepanelProcessor implements SpanProcessor {
  private readonly open = new Map<string, Building>();

  constructor(
    private readonly config: Config,
    private readonly sink: Sink,
  ) {}

  onStart(span: SdkSpan, _parentContext: Context): void {
    const context = span.spanContext();
    const parent = span.parentSpanContext;
    let building = this.open.get(context.traceId);
    if (!parent) {
      // Work outside a request (a script, a job) isn't traced yet.
      if (span.kind !== SpanKind.SERVER) return;
      if (NEXT_INTERNAL.test(String(first(attrsOf(span), "http.target", "url.path") ?? ""))) return;
      this.dropAbandoned();
      building = this.start();
      const rootAttrs = attrsOf(span);
      building.request = requestKey(
        first(rootAttrs, "http.request.method", "http.method"),
        first(rootAttrs, "http.target", "url.path"),
      );
      this.open.set(context.traceId, building);
    }
    if (!building) return;
    const found = origin(this.config.root);
    if (found) building.lastOrigin = found;
    if (parent && skipped(span)) {
      building.ids.set(context.spanId, building.ids.get(parent.spanId) ?? null);
      return;
    }
    const attrs = attrsOf(span);
    if (attrs["express.type"] === "request_handler") building.expressHandlers.add(context.spanId);
    if (parent && attrs["nestjs.type"] === "request_context" && building.expressHandlers.has(parent.spanId)) {
      // Nest's router is Express's route handler: the controller's span takes its place in the tree.
      building.replaced.add(parent.spanId);
      building.ids.set(parent.spanId, building.parents.get(parent.spanId) ?? null);
      building.framework = "NestJS";
    }
    building.parents.set(context.spanId, parent ? (building.ids.get(parent.spanId) ?? null) : null);
    if (!parent && attrs["next.span_type"] === "BaseServer.handleRequest") building.framework = "Next.js";
    building.ids.set(context.spanId, newId());
    building.origins.set(context.spanId, found ?? building.lastOrigin);
  }

  onEnd(span: ReadableSpan): void {
    if (process.env.TRACEPANEL_DEBUG) {
      process.stderr.write(
        `[tracepanel] ${span.name} kind=${span.kind} parent=${span.parentSpanContext?.spanId ?? "-"} ${JSON.stringify(span.attributes)}\n`,
      );
    }
    const context = span.spanContext();
    const building = this.open.get(context.traceId);
    if (!building) return;
    const root = !span.parentSpanContext;
    if (building.replaced.has(context.spanId)) return;
    if (root || !skipped(span)) this.convert(building, span, root);
    if (!root) return;
    setTimeout(() => {
      this.open.delete(context.traceId);
      this.finish(building, span);
      this.sink.submit(building.trace);
    }, LATE_SPANS_MS).unref();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** The trace being built for the active request, with the current span's Tracepanel id. */
  current(): { building: Building; spanId: string | null } | undefined {
    const span = trace.getActiveSpan();
    if (!span) return undefined;
    const context = span.spanContext();
    const building = this.open.get(context.traceId);
    return building ? { building, spanId: building.ids.get(context.spanId) ?? null } : undefined;
  }

  /** What the widget shows before the request's span ends: its id, its queries so far and their time. */
  timing(request?: { method: string; url: string }): Timing | undefined {
    const building = this.current()?.building ?? (request ? this.waiting(request) : undefined);
    if (!building) return undefined;
    // A response's headers took it: another response to the same URL is another request's.
    if (request) building.answered = true;
    return {
      id: building.trace.id,
      queries: building.queries,
      dbMs: building.dbTime / 1000,
      startedMs: building.startedMs,
    };
  }

  private dropAbandoned(): void {
    const oldest = performance.now() - ABANDONED_MS;
    for (const [traceId, building] of this.open) {
      if (building.startedMs < oldest) this.open.delete(traceId);
    }
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

  addLog(log: Omit<Log, "span_id">): void {
    const current = this.current();
    current?.building.trace.logs.push({ ...log, span_id: current.spanId });
  }

  /** The framework the active request runs on, unless a more specific one (Nest on Express) already said so. */
  setFramework(name: string): void {
    const current = this.current();
    if (current && current.building.framework === "node:http") current.building.framework = name;
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
      queries: 0,
      dbTime: 0,
      framework: "node:http",
      startedMs: performance.now(),
      request: "",
      answered: false,
      replaced: new Set(),
      nestViews: new Set(),
      expressHandlers: new Set(),
      parents: new Map(),
      lastOrigin: null,
    };
  }

  /** A span as Tracepanel draws it: the request, a route handler (view), a statement (sql), an outgoing call. */
  private convert(building: Building, span: ReadableSpan, root: boolean): void {
    const context = span.spanContext();
    const id = building.ids.get(context.spanId);
    if (!id) return;
    const parentId = root ? null : (building.ids.get(span.parentSpanContext?.spanId ?? "") ?? null);
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
    const sql = statementOf(attrs);
    if (root) {
      converted.kind = "http";
    } else if (attrs["express.type"] === "request_handler") {
      converted.kind = "view";
      converted.name = String(attrs["express.name"] ?? span.name);
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
    } else if (sql) {
      converted.kind = "sql";
      converted.name = spanName(sql);
      converted.attrs = this.sqlAttrs(attrs, sql, codeOrigin);
      building.queries += 1;
      building.dbTime += converted.duration;
    } else if (span.kind === SpanKind.CLIENT && first(attrs, "http.request.method", "http.method")) {
      converted.kind = "http.client";
      converted.attrs = { ...attrs, "code.origin": codeOrigin };
    } else {
      converted.attrs = { ...attrs, "code.origin": codeOrigin };
    }
    building.trace.spans.push(converted);
    this.collectErrors(building, span, id);
  }

  private sqlAttrs(attrs: Attrs, sql: string, codeOrigin: string | null): Attrs {
    const system = String(first(attrs, "db.system.name", "db.system") ?? "");
    // pg reports the parameters with enhancedDatabaseReporting: the same statement with the same values is a
    // duplicate, the same statement with other values an N+1 candidate.
    const values = first(attrs, "db.postgresql.values", "db.query.parameter");
    return {
      "db.client": system === "postgresql" ? "pg" : system,
      "db.system": system,
      "db.vendor": system,
      "db.alias": "default",
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
      building.trace.errors.push({
        span_id: spanId,
        time: Math.round(seconds * 1e6 + nanos / 1e3),
        type: String(attrs["exception.type"] ?? "Error"),
        message: String(attrs["exception.message"] ?? ""),
        handled: false,
        frames: frames(String(attrs["exception.stacktrace"] ?? ""), this.config.root),
        chain: [],
      });
    }
  }

  /** The trace from its root span: name, timing, the request's attributes. */
  private finish(building: Building, root: ReadableSpan): void {
    const attrs = attrsOf(root);
    const method = String(first(attrs, "http.request.method", "http.method") ?? "GET");
    const path = String(first(attrs, "url.path", "http.target") ?? "/").split("?")[0];
    const route = first(attrs, "http.route", "next.route");
    const status = Number(first(attrs, "http.response.status_code", "http.status_code") ?? 0);
    const tr = building.trace;
    if (status > 0 && status < 500) {
      // Nest throws NotFoundException and the like to answer 404, 422…: an answer, not an error.
      tr.errors = tr.errors.filter((error) => !building.nestViews.has(error.span_id ?? ""));
    }
    tr.name = `${method} ${typeof route === "string" && route ? route : path}`;
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
      "process.runtime.name": "node",
      "process.runtime.version": process.versions.node,
      "tracepanel.framework": building.framework,
    };
  }
}

export interface Timing {
  id: string;
  queries: number;
  dbMs: number;
  /** performance.now() as the request started. */
  startedMs: number;
}

function requestKey(method: unknown, target: unknown): string {
  return `${String(method ?? "GET").toUpperCase()} ${String(target ?? "/")}`;
}

/** `Node 26 · Express`: what the panel shows next to its logo. */
export function runtimeLabel(framework: string): string {
  return `Node ${process.versions.node.split(".")[0]} · ${framework}`;
}

export { micros };
