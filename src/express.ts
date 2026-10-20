// `app.use(tracepanel())`: every response gets what the badge reads (Tracepanel-Id, Server-Timing), and HTML pages
// get widget.min.js. A response the handler ends at once (a page, a JSON answer) is held until then; one written in
// pieces without a Content-Length is a stream, and goes out as it comes, an HTML page with the script put in as it
// passes.

import type { NextFunction, Request, Response } from "express";
import { runtime } from "./runtime.js";
import { badge, exposedHeaders, inject, Stream, streamablePage } from "./widget.js";

type Write = Response["write"];
type End = Response["end"];
type Callback = (error?: Error | null) => void;

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
    // A streamed HTML page: what puts the script into it.
    let script: Stream | undefined;

    const flushHeld = () => {
      if (chunks.length > 0) write(Buffer.concat(chunks.splice(0)));
    };

    /** The badge's headers on the response; its script tag when it is a page that gets one. */
    const mark = (page: boolean): string | undefined => {
      const framework = tp.processor.framework() ?? "Express";
      const marks = badge(tp, { method: req.method, status: res.statusCode, startedMs, page, framework });
      if (!marks) return undefined;
      for (const [name, value] of Object.entries(marks.headers)) res.setHeader(name, value);
      const expose = exposedHeaders(
        res.getHeader("access-control-allow-origin"),
        res.getHeader("access-control-expose-headers"),
      );
      if (expose) res.setHeader("Access-Control-Expose-Headers", expose);
      return marks.script;
    };

    /** A stream: the badge's headers now, with the time so far, and the script for an HTML page as it is. */
    const startStream = () => {
      streaming = true;
      if (res.headersSent) return;
      const page = streamablePage((name) => res.getHeader(name));
      const tag = mark(page);
      if (page && tag) script = new Stream(tag);
    };

    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      // Its size declared, a body in pieces is held whole like a page ended at once; without one it is a stream.
      if (!streaming && res.getHeader("content-length") === undefined) startStream();
      if (streaming) {
        flushHeld();
        if (!script) return write(chunk as never, encoding as never, callback as never);
        const done = (typeof encoding === "function" ? encoding : callback) as Callback | undefined;
        const piece = toBuffer(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined);
        return done ? write(script.feed(piece), done) : write(script.feed(piece));
      }
      chunks.push(toBuffer(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined));
      if (typeof encoding === "function") (encoding as () => void)();
      else if (typeof callback === "function") (callback as () => void)();
      return true;
    }) as Write;

    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      res.write = write;
      res.end = end;
      if (typeof chunk === "function") [chunk, encoding, callback] = [undefined, undefined, chunk];
      else if (typeof encoding === "function") [encoding, callback] = [undefined, encoding];
      const last =
        chunk === undefined || chunk === null
          ? undefined
          : toBuffer(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined);
      if (streaming) {
        flushHeld();
        const rest = script ? Buffer.concat([script.feed(last ?? Buffer.alloc(0)), script.end()]) : last;
        return rest && rest.length > 0 ? end(rest, callback as never) : end(callback as never);
      }
      if (last) chunks.push(last);
      if (res.headersSent) {
        flushHeld();
        return end(callback as never);
      }
      let body = Buffer.concat(chunks);
      const page = String(res.getHeader("content-type") ?? "").includes("text/html");
      const tag = mark(page);
      if (tag) body = Buffer.from(inject(body.toString("utf8"), tag));
      if (!res.getHeader("transfer-encoding")) res.setHeader("Content-Length", body.length);
      return end(body, callback as never);
    }) as End;

    next();
  };
}
