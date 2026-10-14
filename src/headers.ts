// For frameworks that answer from their own server (Next.js, Nuxt): every response of a traced request gets what the
// widget and the badge read, Tracepanel-Id, Tracepanel-Url and Server-Timing, as its headers go out.

import { ServerResponse } from "node:http";
import type { Runtime } from "./runtime.js";

const PATCHED = Symbol.for("tracepanel.headers");

export function headersOnResponses(tracepanel: Runtime, framework: string): void {
  const prototype = ServerResponse.prototype as ServerResponse & { [PATCHED]?: boolean };
  if (prototype[PATCHED]) return;
  prototype[PATCHED] = true;
  const writeHead = prototype.writeHead;
  prototype.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    if (!this.headersSent) {
      const marks = tracepanel.badge({
        method: this.req?.method ?? "GET",
        url: this.req?.url ?? "/",
        status: typeof args[0] === "number" ? args[0] : this.statusCode,
        startedMs: performance.now(),
        page: false,
        framework: tracepanel.processor.framework() ?? framework,
      });
      for (const [name, value] of Object.entries(marks?.headers ?? {})) {
        if (!this.hasHeader(name)) this.setHeader(name, value);
      }
    }
    return (writeHead as (...params: unknown[]) => ServerResponse).apply(this, args);
  } as typeof writeHead;
}
