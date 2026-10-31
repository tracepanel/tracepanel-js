// Bun's own server, Bun.serve, doesn't go through node:http: a request's root span comes from here. `serve()` takes
// Bun.serve's options; `withTracepanel()` wraps any fetch handler (Hono's app.fetch, Elysia's handle).
//
//   import { serve } from "@tracepanel/js/bun";
//   serve({ routes: { "/api/books/:id": (req) => ... }, fetch: (req) => ... });
//
// Start the app with `bun --preload @tracepanel/js/register server.ts` so the database driver is hooked as it loads.
//
// What a request carried goes into its trace: its headers, query and cookies, its body as far as the handler read it,
// and the response's headers. The handler reads the body's stream itself: its pieces pass a tap on their way to it
// (body.ts), and Tracepanel never reads it for the app.

import { propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { tapRequest } from "./body.js";
import { askAttributes, asks } from "./profile.js";
import { MARKED, marked } from "./respond.js";
import { start } from "./setup.js";

type Handler = (request: Request, server?: unknown) => Response | Promise<Response>;
type ErrorHandler = (error: Error) => Response | Promise<Response>;
type Routes = Record<string, Handler | Record<string, Handler> | Response>;

const tracer = trace.getTracer("tracepanel-bun");

/** What Bun answers an error with when the app has no `error` handler of its own. */
function internalError(error: Error): Response {
  // biome-ignore lint/suspicious/noConsole: printing the error is what Bun does in this case too
  console.error(error);
  return new Response("Internal Server Error", { status: 500 });
}

/**
 * The handler, in a server span for each request: its route, status, errors; the badge's headers and script. An
 * error it throws is answered here, by `onError` (Bun.serve's `error` option) or a 500, so the answer has its trace.
 */
export function withTracepanel<H extends Handler>(handler: H, route?: string, onError?: ErrorHandler): H {
  const tracepanel = start({ httpServer: false });
  if (!tracepanel) return handler;
  const traced = (request: Request, server?: unknown) => {
    const url = new URL(request.url);
    const ask = asks(Object.fromEntries(request.headers));
    const attributes = {
      "http.request.method": request.method,
      "url.path": url.pathname,
      "http.target": url.pathname + url.search,
      ...(route ? { "http.route": route } : {}),
      ...askAttributes(ask),
    };
    const startedMs = performance.now();
    // The caller's traceparent, as Node's http instrumentation reads it: the agent links the caller's trace to this.
    const caller = propagation.extract(ROOT_CONTEXT, request.headers, {
      get: (headers, key) => headers.get(key) ?? undefined,
      keys: (headers) => [...headers.keys()],
    });
    const options = { kind: SpanKind.SERVER, attributes };
    const body = tracepanel.config.captureRequest ? tapRequest(request) : undefined;
    // Its response is marked here: Hono's middleware under this leaves it.
    (request as Request & { [MARKED]?: true })[MARKED] = true;
    return tracer.startActiveSpan(`${request.method}`, options, caller, async (span) => {
      tracepanel.processor.setFramework("Bun.serve");
      // A page streamed through the widget's script: its request ends with the body.
      let streamed: Promise<void> | undefined;
      try {
        let response: Response;
        try {
          response = await handler(request, server);
        } catch (thrown) {
          const error = thrown instanceof Error ? thrown : new Error(String(thrown));
          span.recordException(error);
          response = await (onError ?? internalError)(error);
        }
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        const answer = await marked(tracepanel, request, response, startedMs, "Bun.serve", body);
        streamed = answer.ended;
        return answer.response;
      } finally {
        if (streamed) void streamed.then(() => span.end());
        else span.end();
      }
    });
  };
  return traced as H;
}

/** Bun.serve's routes, each handler traced under its pattern: `/api/books/:id`. */
function tracedRoutes(routes: Routes, onError?: ErrorHandler): Routes {
  const traced: Routes = {};
  for (const [pattern, value] of Object.entries(routes)) {
    if (typeof value === "function") {
      traced[pattern] = withTracepanel(value, pattern, onError);
    } else if (value instanceof Response) {
      traced[pattern] = value;
    } else {
      const methods: Record<string, Handler> = {};
      for (const [method, handler] of Object.entries(value)) {
        methods[method] = withTracepanel(handler, pattern, onError);
      }
      traced[pattern] = methods;
    }
  }
  return traced;
}

/** Bun.serve, with every route and the fetch fallback traced. */
export function serve<T extends { routes?: Routes; fetch?: Handler; error?: ErrorHandler }>(options: T): unknown {
  const bun = (globalThis as { Bun?: { serve(options: unknown): unknown } }).Bun;
  if (!bun) throw new Error("@tracepanel/js/bun's serve() runs on Bun");
  return bun.serve({
    ...options,
    ...(options.routes ? { routes: tracedRoutes(options.routes, options.error) } : {}),
    ...(options.fetch ? { fetch: withTracepanel(options.fetch, undefined, options.error) } : {}),
  });
}
