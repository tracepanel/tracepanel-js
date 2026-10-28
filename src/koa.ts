// `app.use(tracepanel())`, first: Koa middleware. The handler of each @koa/router route is a span of its own, named
// by its route (`/books/:id`), and so is the request's trace. Every response gets what the badge reads
// (Tracepanel-Id, Server-Timing), an error's answer too, and an HTML page the widget's script: a string or a Buffer
// has it put into its body, a stream as it passes. What the request carried goes into its trace as the response goes
// out: its headers, query, cookies, the body a body parser read (`ctx.request.body`, its files), the session
// (`ctx.session`), and the response's headers. An error is the request's unless Koa answers it below 500 (`ctx.throw(404)`).
//
// The handlers are found from the app's middleware, as the request comes: the routers it mounted (`router.routes()`,
// and the routers nested in them), each route's last function its handler. OpenTelemetry's Koa instrumentation does
// the same from Koa's `use()`, once, with a span for each middleware besides; here the routes added later count too.

import type { Readable } from "node:stream";
import type { Context, Middleware, Next } from "koa";
import type { Attrs } from "./model.js";
import { hasBody, parsedBody, requestAttrs, responseHeaders, searchOf } from "./request.js";
import { type Runtime, runtime } from "./runtime.js";
import { expressSession } from "./session.js";
import { inView, statusOf, wasRecorded } from "./view.js";
import { inject, responseMarks, streamablePage, streamWith } from "./widget.js";

const FRAMEWORK = "Koa";
const TRACED = Symbol.for("tracepanel.koa.handler");

type Fn = ((ctx: Context, next: Next) => unknown) & { router?: Router; [TRACED]?: true };
interface Layer {
  path: string | RegExp;
  methods: string[];
  stack: Fn[];
}
interface Router {
  stack: Layer[];
}

// How many layers each router had when its handlers were traced: a route added since is traced as it comes.
const seen = new WeakMap<Router, number>();

/** Each route's handler in a span, in every router among these middleware, and in the routers nested in them. */
function traceRoutes(middleware: readonly Fn[]): void {
  for (const fn of middleware) {
    const router = fn.router;
    if (!router || !Array.isArray(router.stack) || seen.get(router) === router.stack.length) continue;
    seen.set(router, router.stack.length);
    for (const layer of router.stack) {
      if (!Array.isArray(layer.stack)) continue;
      traceRoutes(layer.stack);
      const last = layer.stack.length - 1;
      const handler = layer.stack[last];
      // A route's own layer has its methods; router.use()'s middleware has none.
      if (!handler || handler.router || handler[TRACED] || layer.methods.length === 0) continue;
      const route = String(layer.path);
      const traced: Fn = (ctx, next) => inView(route, null, () => handler(ctx, next));
      traced[TRACED] = true;
      layer.stack[last] = traced;
    }
  }
}

function isStream(body: unknown): body is Readable {
  return body !== null && typeof body === "object" && typeof (body as Readable).pipe === "function";
}

interface Carried {
  request: { body?: unknown; files?: unknown };
  session?: unknown;
}

/** What the request carried, the body a parser read, the session as the handler left it, the response's headers. */
function carried(ctx: Context): Attrs {
  const { request, session } = ctx as Context & Carried;
  const body = hasBody(ctx.headers)
    ? parsedBody({ contentType: ctx.get("content-type"), body: request.body, files: request.files })
    : {};
  return {
    ...requestAttrs(ctx.headers, searchOf(ctx.originalUrl ?? ctx.url)),
    ...body,
    ...expressSession(session),
    ...responseHeaders(Object.entries(ctx.response.headers)),
  };
}

/** The route @koa/router matched, the request's name. */
function named(tp: Runtime, ctx: Context): void {
  const route = (ctx as Context & { _matchedRoute?: unknown })._matchedRoute;
  if (route !== undefined) tp.processor.setRoute(String(route));
}

export function tracepanel(): Middleware {
  const tp = runtime();
  return async function tracepanelMiddleware(ctx: Context, next: Next): Promise<void> {
    if (!tp) {
      await next();
      return;
    }
    tp.processor.setFramework(FRAMEWORK);
    const startedMs = performance.now();
    traceRoutes(ctx.app.middleware as Fn[]);
    const badge = (status: number, page: boolean) =>
      responseMarks(
        tp,
        { method: ctx.method, status, startedMs, page, framework: tp.processor.framework() ?? FRAMEWORK },
        ctx.headers,
        (name) => ctx.response.get(name) || undefined,
      );
    try {
      await next();
    } catch (error) {
      named(tp, ctx);
      if (statusOf(error) >= 500 && !wasRecorded(error)) tp.processor.addError(error);
      if (tp.config.captureRequest) tp.processor.setTraceAttrs(carried(ctx));
      // Koa answers it once it is out of here, its headers cleared but for the error's own: the badge's go with them.
      const marks = badge(statusOf(error), false);
      if (marks && error !== null && typeof error === "object") {
        const own = (error as { headers?: Record<string, unknown> }).headers;
        const headers: Record<string, unknown> = { ...own, ...marks.headers };
        if (marks.cookie) headers["Set-Cookie"] = marks.cookie;
        Object.assign(error, { headers });
      }
      throw error;
    }
    named(tp, ctx);
    if (tp.config.captureRequest) tp.processor.setTraceAttrs(carried(ctx));
    const { body } = ctx;
    const header = (name: string) => ctx.response.get(name) || undefined;
    const html = Boolean(ctx.response.is("html")) && !header("content-encoding");
    const whole = typeof body === "string" || Buffer.isBuffer(body);
    const page = html && (whole || (isStream(body) && streamablePage(header)));
    const marks = badge(ctx.status, page);
    if (!marks) return;
    ctx.set(marks.headers);
    if (marks.cookie) ctx.append("Set-Cookie", marks.cookie);
    if (!page || !marks.script) return;
    // Koa sets the new body's Content-Length, and leaves a stream's out.
    if (isStream(body)) ctx.body = streamWith(body, marks.script);
    else ctx.body = inject(Buffer.isBuffer(body) ? body.toString("utf8") : (body as string), marks.script);
  };
}
