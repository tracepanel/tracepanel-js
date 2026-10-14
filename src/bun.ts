// Bun's own server, Bun.serve, doesn't go through node:http: a request's root span comes from here. `serve()` takes
// Bun.serve's options; `withTracepanel()` wraps any fetch handler (Hono's app.fetch, Elysia's handle).
//
//   import { serve } from "tracepanel/bun";
//   serve({ routes: { "/api/books/:id": (req) => ... }, fetch: (req) => ... });
//
// Start the app with `bun --preload tracepanel/register server.ts` so the database driver is hooked as it loads.

import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Runtime } from "./runtime.js";
import { start } from "./setup.js";
import { exposedHeaders, inject } from "./widget.js";

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
    const attributes = {
      "http.request.method": request.method,
      "url.path": url.pathname,
      "http.target": url.pathname + url.search,
      ...(route ? { "http.route": route } : {}),
    };
    const startedMs = performance.now();
    return tracer.startActiveSpan(`${request.method}`, { kind: SpanKind.SERVER, attributes }, async (span) => {
      tracepanel.processor.setFramework("Bun.serve");
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
        return await marked(tracepanel, request, response, startedMs);
      } finally {
        span.end();
      }
    });
  };
  return traced as H;
}

/** The trace's headers on the response, and the widget in an HTML page. */
async function marked(tracepanel: Runtime, request: Request, response: Response, startedMs: number): Promise<Response> {
  const page = (response.headers.get("content-type") ?? "").includes("text/html");
  const marks = tracepanel.badge({
    method: request.method,
    status: response.status,
    startedMs,
    page,
    framework: tracepanel.processor.framework() ?? "Bun.serve",
  });
  if (!marks) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(marks.headers)) headers.set(name, value);
  const expose = exposedHeaders(
    headers.get("access-control-allow-origin") ?? undefined,
    headers.get("access-control-expose-headers"),
  );
  if (expose) headers.set("Access-Control-Expose-Headers", expose);
  if (!marks.script) return new Response(response.body, { status: response.status, headers });
  headers.delete("content-length");
  const body = inject(await response.text(), marks.script);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
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
  if (!bun) throw new Error("tracepanel/bun's serve() runs on Bun");
  return bun.serve({
    ...options,
    ...(options.routes ? { routes: tracedRoutes(options.routes, options.error) } : {}),
    ...(options.fetch ? { fetch: withTracepanel(options.fetch, undefined, options.error) } : {}),
  });
}
