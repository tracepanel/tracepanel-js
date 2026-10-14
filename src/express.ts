// `app.use(tracepanel())`: every response gets what the badge reads (Tracepanel-Id, Server-Timing), and HTML pages
// get widget.min.js. The response is held until the handler ends it: a page or a JSON answer, not a stream.

import type { NextFunction, Request, Response } from "express";
import { runtime } from "./runtime.js";
import { badge, exposedHeaders, inject } from "./widget.js";

type Write = Response["write"];
type End = Response["end"];

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding);
}

export function tracepanel() {
  const tp = runtime();
  return function tracepanelMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!tp) {
      next();
      return;
    }
    tp.processor.setFramework("Express");
    const startedMs = performance.now();
    const chunks: Buffer[] = [];
    const write = res.write.bind(res) as Write;
    const end = res.end.bind(res) as End;
    let streaming = false;

    const flushHeld = () => {
      if (chunks.length > 0) write(Buffer.concat(chunks.splice(0)));
    };

    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      if (streaming || String(res.getHeader("content-type")).includes("text/event-stream")) {
        streaming = true;
        flushHeld();
        return write(chunk as never, encoding as never, callback as never);
      }
      chunks.push(toBuffer(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined));
      if (typeof encoding === "function") (encoding as () => void)();
      else if (typeof callback === "function") (callback as () => void)();
      return true;
    }) as Write;

    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      res.write = write;
      res.end = end;
      if (typeof chunk === "function") return end(chunk as () => void);
      if (chunk !== undefined && chunk !== null && !streaming) {
        chunks.push(toBuffer(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined));
      } else if (streaming && chunk !== undefined && chunk !== null) {
        return end(chunk as never, encoding as never, callback as never);
      }
      if (streaming || res.headersSent) {
        flushHeld();
        return end(callback as never);
      }
      let body = Buffer.concat(chunks);
      const page = String(res.getHeader("content-type") ?? "").includes("text/html");
      const framework = tp.processor.framework() ?? "Express";
      const marks = badge(tp, { method: req.method, status: res.statusCode, startedMs, page, framework });
      if (marks) {
        for (const [name, value] of Object.entries(marks.headers)) res.setHeader(name, value);
        const expose = exposedHeaders(
          res.getHeader("access-control-allow-origin"),
          res.getHeader("access-control-expose-headers"),
        );
        if (expose) res.setHeader("Access-Control-Expose-Headers", expose);
        if (marks.script) body = Buffer.from(inject(body.toString("utf8"), marks.script));
      }
      if (!res.getHeader("transfer-encoding")) res.setHeader("Content-Length", body.length);
      return end(body, callback as never);
    }) as End;

    next();
  };
}
