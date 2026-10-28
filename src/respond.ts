// A fetch handler's response (Bun.serve's, Hono's) as it goes out: the trace's headers on it, the widget's script in an
// HTML page, and what the request carried into its trace.

import type { BodyTap } from "./body.js";
import { redirectCookie, requestAttrs, responseHeaders } from "./request.js";
import type { Runtime } from "./runtime.js";
import { exposedHeaders, inject, Stream, streamablePage } from "./widget.js";

/** On a request whose response withTracepanel() marks: a framework's middleware under it leaves the response be. */
export const MARKED = Symbol.for("tracepanel.marked");

/**
 * The trace's headers on the response, and the widget in an HTML page: put into its body as it streams when its size
 * isn't declared, with `ended` settled once that body has gone out.
 */
export async function marked(
  tracepanel: Runtime,
  request: Request,
  response: Response,
  startedMs: number,
  framework: string,
  body?: BodyTap,
): Promise<{ response: Response; ended?: Promise<void> }> {
  if (tracepanel.config.captureRequest) {
    tracepanel.processor.setTraceAttrs({
      ...requestAttrs(Object.fromEntries(request.headers), new URL(request.url).search),
      ...body?.attrs(),
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
    framework: tracepanel.processor.framework() ?? framework,
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
