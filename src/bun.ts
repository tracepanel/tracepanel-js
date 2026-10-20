// Bun's own server, Bun.serve, doesn't go through node:http: a request's root span comes from here. `serve()` takes
// Bun.serve's options; `withTracepanel()` wraps any fetch handler (Hono's app.fetch, Elysia's handle).
//
//   import { serve } from "@tracepanel/js/bun";
//   serve({ routes: { "/api/books/:id": (req) => ... }, fetch: (req) => ... });
//
// Start the app with `bun --preload @tracepanel/js/register server.ts` so the database driver is hooked as it loads.
//
// What a request carried goes into its trace: its headers, query and cookies, and the response's headers. Not its
// body: the handler reads that stream itself, and Tracepanel never reads it for the app.

import { propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { redirectCookie, requestAttrs, responseHeaders } from "./request.js";
import type { Runtime } from "./runtime.js";
import { start } from "./setup.js";
import { exposedHeaders, inject, Stream, streamablePage } from "./widget.js";

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
    // The caller's traceparent, as Node's http instrumentation reads it: the agent links the caller's trace to this.
    const caller = propagation.extract(ROOT_CONTEXT, request.headers, {
      get: (headers, key) => headers.get(key) ?? undefined,
      keys: (headers) => [...headers.keys()],
    });
    const options = { kind: SpanKind.SERVER, attributes };
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
        const answer = await marked(tracepanel, request, response, startedMs);
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

/**
 * The trace's headers on the response, and the widget in an HTML page: put into its body as it streams when its size
 * isn't declared, with `ended` settled once that body has gone out.
 */
async function marked(
  tracepanel: Runtime,
  request: Request,
  response: Response,
  startedMs: number,
): Promise<{ response: Response; ended?: Promise<void> }> {
  if (tracepanel.config.captureRequest) {
    tracepanel.processor.setTraceAttrs({
      ...requestAttrs(Object.fromEntries(request.headers), new URL(request.url).search),
      ...responseHeaders(response.headers.entries()),
    });
  }
  const html = (response.headers.get("content-type") ?? "").includes("text/html");
  const page = html && !response.headers.has("content-encoding");
  const marks = tracepanel.badge({
    method: request.method,
    status: response.status,
    startedMs,
    page,
    framework: tracepanel.processor.framework() ?? "Bun.serve",
  });
  if (!marks) return { response };
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(marks.headers)) headers.set(name, value);
  const redirect = redirectCookie(
    marks.headers["Tracepanel-Id"] ?? "",
    response.status,
    Object.fromEntries(request.headers),
  );
  if (redirect) headers.append("Set-Cookie", redirect);
  const expose = exposedHeaders(
    headers.get("access-control-allow-origin") ?? undefined,
    headers.get("access-control-expose-headers"),
  );
  if (expose) headers.set("Access-Control-Expose-Headers", expose);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (!marks.script || !response.body) return { response: new Response(response.body, init) };
  if (streamablePage((name) => headers.get(name))) {
    let ended = () => {};
    const done = new Promise<void>((resolve) => (ended = resolve));
    return { response: new Response(through(response.body, new Stream(marks.script), ended), init), ended: done };
  }
  headers.delete("content-length");
  return { response: new Response(inject(await response.text(), marks.script), init) };
}

/** A body through the widget's script, piece by piece as the client reads it; `ended` once it is over. */
function through(body: ReadableStream<Uint8Array>, script: Stream, ended: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Until something goes out: a pull that enqueues nothing is not called again.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const rest = script.end();
            if (rest.length > 0) controller.enqueue(rest);
            controller.close();
            ended();
            return;
          }
          const piece = script.feed(value);
          if (piece.length > 0) {
            controller.enqueue(piece);
            return;
          }
        }
      } catch (error) {
        controller.error(error);
        ended();
      }
    },
    async cancel(reason) {
      ended();
      await reader.cancel(reason);
    },
  });
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
