// `app.use(tracepanel())`: every response gets what the badge reads (Tracepanel-Id, Server-Timing), and HTML pages
// get widget.min.js. A response the handler ends at once (a page, a JSON answer) is held until then; one written in
// pieces without a Content-Length is a stream, and goes out as it comes, an HTML page with the script put in as it
// passes. What the request carried goes into its trace as the response goes out: its headers, query, cookies, the
// body a body parser read (`req.body`, an upload's files), the session (`req.session`), and the response's headers. A redirect that answers a
// page's navigation (a form's POST) sets the cookie that shows it in the next page's panel. A handler that reads the
// body from the stream itself (GraphQL Yoga) has it recorded as it read it. One that writes its headers itself with
// `res.writeHead()` before its body (Yoga, a Node handler under `app.use()`) gets the badge's headers then, and its
// HTML page no script.

import type { OutgoingHttpHeaders } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { tapIncoming, tapOf } from "./body.js";
import type { Attrs } from "./model.js";
import { hasBody, parsedBody, redirectCookie, requestAttrs, responseHeaders, searchOf } from "./request.js";
import { runtime } from "./runtime.js";
import { expressSession } from "./session.js";
import { badge, exposedHeaders, inject, Stream, streamablePage } from "./widget.js";

type Write = Response["write"];
type End = Response["end"];
type WriteHead = Response["writeHead"];
type Callback = (error?: Error | null) => void;

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding);
}

/**
 * What the request carried, the body as far as the app's body parser read it, the session as the handler left it
 * (express-session's, cookie-session's), and the response's headers so far.
 */
function carried(req: Request, res: Response): Attrs {
  const upload = req as Request & { file?: unknown; files?: unknown; session?: unknown };
  const parsed =
    req.body !== undefined || upload.file !== undefined || upload.files !== undefined
      ? parsedBody({
          contentType: req.headers["content-type"] ?? "",
          body: req.body,
          file: upload.file,
          files: upload.files,
        })
      : undefined;
  // No body parser read it: as far as the handler read it from the stream.
  const body = hasBody(req.headers) ? (parsed ?? tapOf(req)?.attrs() ?? {}) : {};
  return {
    ...requestAttrs(req.headers, searchOf(req.originalUrl ?? req.url)),
    ...body,
    ...expressSession(upload.session),
    ...responseHeaders(Object.entries(res.getHeaders())),
  };
}

function pairsOf(flat: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let at = 0; at + 1 < flat.length; at += 2) pairs.push([String(flat[at]), String(flat[at + 1])]);
  return pairs;
}

export function tracepanel() {
  const tp = runtime();
  return function tracepanelMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!tp) {
      next();
      return;
    }
    tp.processor.setFramework("Express");
    // A handler may read the body from the stream itself: its pieces pass the tap on their way.
    if (tp.config.captureRequest && hasBody(req.headers) && !req.readableEnded && !tapOf(req)) tapIncoming(req);
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

    const writeHead = res.writeHead.bind(res) as WriteHead;
    let recorded = false;
    let marked = false;
    /** What the request carried, into its trace once, before the badge's headers join the response's. */
    const record = () => {
      if (recorded || !tp.config.captureRequest) return;
      recorded = true;
      tp.processor.setTraceAttrs(carried(req, res));
    };

    /** The badge's headers on the response; its script tag when it is a page that gets one. */
    const mark = (page: boolean): string | undefined => {
      record();
      marked = true;
      const framework = tp.processor.framework() ?? "Express";
      const marks = badge(tp, { method: req.method, status: res.statusCode, startedMs, page, framework });
      if (!marks) return undefined;
      for (const [name, value] of Object.entries(marks.headers)) res.setHeader(name, value);
      const redirect = redirectCookie(marks.headers["Tracepanel-Id"] ?? "", res.statusCode, req.headers);
      if (redirect) res.appendHeader("Set-Cookie", redirect);
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
      if (res.headersSent) {
        record();
        return;
      }
      const page = streamablePage((name) => res.getHeader(name));
      const tag = mark(page);
      if (page && tag) script = new Stream(tag);
    };

    // A handler that writes its headers itself, before its body: the badge's go with them. Headers passed here join
    // the response's own first, so a CORS one among them exposes the badge's.
    res.writeHead = ((status: number, ...rest: unknown[]) => {
      if (marked || res.headersSent) return (writeHead as (...args: unknown[]) => Response)(status, ...rest);
      const message = typeof rest[0] === "string" ? rest[0] : undefined;
      const given = (message === undefined ? rest[0] : rest[1]) as OutgoingHttpHeaders | unknown[] | undefined;
      res.statusCode = status;
      if (Array.isArray(given)) {
        // Raw headers: [name, value, ...] or [[name, value], ...].
        const pairs = Array.isArray(given[0]) ? (given as [string, string][]) : pairsOf(given as string[]);
        for (const [name, value] of pairs) res.appendHeader(name, value);
      } else if (given) {
        for (const [name, value] of Object.entries(given)) if (value !== undefined) res.setHeader(name, value);
      }
      mark(false);
      return message === undefined ? writeHead(status) : writeHead(status, message);
    }) as WriteHead;

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
        record();
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
