// For frameworks that answer from their own server (Next.js, Nuxt): every response of a traced request gets what the
// widget and the badge read, Tracepanel-Id, Tracepanel-Url and Server-Timing, as its headers go out. Then too, what
// the request carried goes into its trace (headers, query, cookies, the body as far as the framework read it for the
// app), with the response's headers; and a redirect that answers a page's navigation sets the cookie that shows it in
// the next page's panel. A request's body is tapped as the server hands the request over: the framework reads it from
// the stream, and its pieces pass the tap on their way (body.ts).

import http, { type IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { tapIncoming, tapOf } from "./body.js";
import { hasBody, redirectCookie, requestAttrs, responseHeaders, searchOf } from "./request.js";
import type { Runtime } from "./runtime.js";
import { exposedHeaders } from "./widget.js";

const PATCHED = Symbol.for("tracepanel.headers");
const TAPPING = Symbol.for("tracepanel.body.tapping");

/** The app's HTTP servers (made before this runs too) tap the body of each request that has one. */
function tapBodies(tracepanel: Runtime): void {
  for (const prototype of [http.Server.prototype, https.Server.prototype]) {
    const server = prototype as http.Server & { [TAPPING]?: boolean };
    if (server[TAPPING]) continue;
    server[TAPPING] = true;
    const emit = server.emit;
    server.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]) {
      const req = args[0] as IncomingMessage | undefined;
      if (event === "request" && req && tracepanel.config.captureRequest && hasBody(req.headers) && !tapOf(req)) {
        tapIncoming(req);
      }
      return emit.call(this, event, ...args);
    } as typeof emit;
  }
}

export function headersOnResponses(tracepanel: Runtime, framework: string): void {
  tapBodies(tracepanel);
  const prototype = ServerResponse.prototype as ServerResponse & { [PATCHED]?: boolean };
  if (prototype[PATCHED]) return;
  prototype[PATCHED] = true;
  const writeHead = prototype.writeHead;
  prototype.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    if (!this.headersSent) {
      const method = this.req?.method ?? "GET";
      const url = this.req?.url ?? "/";
      const status = typeof args[0] === "number" ? args[0] : this.statusCode;
      // Headers passed to writeHead itself (an object) count too: CORS middleware often sets them there.
      const given = [args[1], args[2]].find((arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg));
      const passed = (given ?? {}) as Record<string, unknown>;
      if (tracepanel.config.captureRequest && this.req) {
        // Before the badge: a response sent outside the request's context finds its trace by the URL until then.
        tracepanel.processor.setTraceAttrs(
          {
            ...requestAttrs(this.req.headers, searchOf(url)),
            ...tapOf(this.req)?.attrs(),
            ...responseHeaders([...Object.entries(this.getHeaders()), ...Object.entries(passed)]),
          },
          { method, url },
        );
      }
      const marks = tracepanel.badge({
        method,
        url,
        status,
        startedMs: performance.now(),
        page: false,
        framework: tracepanel.processor.framework() ?? framework,
      });
      for (const [name, value] of Object.entries(marks?.headers ?? {})) {
        if (!this.hasHeader(name)) this.setHeader(name, value);
      }
      const lower = Object.fromEntries(
        Object.entries(passed ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const expose = marks
        ? exposedHeaders(
            this.getHeader("access-control-allow-origin") ?? lower["access-control-allow-origin"],
            this.getHeader("access-control-expose-headers") ?? lower["access-control-expose-headers"],
          )
        : undefined;
      const redirect =
        marks && this.req ? redirectCookie(marks.headers["Tracepanel-Id"] ?? "", status, this.req.headers) : undefined;
      if (redirect) {
        // One passed to writeHead would replace the response's own: the cookie joins it there.
        const named = Object.keys(passed).find((name) => name.toLowerCase() === "set-cookie");
        if (named) passed[named] = [...[passed[named]].flat(), redirect];
        else this.appendHeader("Set-Cookie", redirect);
      }
      if (expose) {
        this.setHeader("Access-Control-Expose-Headers", expose);
        delete (passed as Record<string, unknown>)["access-control-expose-headers"];
        delete (passed as Record<string, unknown>)["Access-Control-Expose-Headers"];
      }
    }
    return (writeHead as (...params: unknown[]) => ServerResponse).apply(this, args);
  } as typeof writeHead;
}
