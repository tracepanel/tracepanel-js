// A response's body, as the app sent it: http.response.body and http.response.body.size in its trace, as the Python
// SDK records them. A tap sees each piece on its way to the client and keeps a copy of the start: the response goes
// out as it would have, at its own pace, nothing held or changed. A Node server's response (`res.write()`,
// `res.end()`: Express, Fastify, Koa, Next.js, Hono's Node server, GraphQL Yoga's and Apollo's answers) is tapped as
// the server hands it over; a fetch handler's (Bun.serve, Hono) as its body is read.
//
// A body sent whole is recorded as a request's is (request.ts): JSON and forms with secrets masked, text as it is, cut
// at bodyLimit() characters. A stream (Server-Sent Events, NDJSON, a Node body written in pieces without a
// Content-Length), a compressed body, a page and its assets, binary content and JSON past MAX_PARSED are recorded by
// their size only: none of it is kept past what tells that. A fetch Response's pieces don't tell a stream (Bun hands
// a string's body over in several): only its type does. TRACEPANEL_CAPTURE_BODY=0 records neither. A page's size is
// the app's own: the widget's script, put in after the app sent the page (Express, Fastify, Koa), isn't counted.

import type { ServerResponse } from "node:http";
import type { Span } from "@opentelemetry/api";
import type { Attrs } from "./model.js";
import { bodyLimit, cut, headerValue, isJson, kindOf, readable } from "./request.js";
import type { Runtime } from "./runtime.js";

/** A response's JSON or form larger than this isn't parsed to mask its secrets, so isn't kept: its size is. */
export const MAX_PARSED = 4 << 20;
/** What a response's body shows elsewhere (a page, its assets): kept by its size only. */
const SHOWN_ELSEWHERE = new Set(["text/html", "text/css", "text/javascript", "application/javascript"]);
/** Bodies that are streams whatever their pieces: events, lines of JSON, parts sent as they are ready. */
const STREAMED = new Set([
  "text/event-stream",
  "application/x-ndjson",
  "application/jsonl",
  "application/stream+json",
  "multipart/mixed",
  "multipart/x-mixed-replace",
]);
const TAP = Symbol.for("tracepanel.response");

/** What a response's headers say of its body, as it went out. */
export interface Sent {
  contentType: string;
  encoding: string;
  /**
   * A body in pieces is a whole all the same: its size was declared (Content-Length), or its pieces don't tell (a
   * fetch Response's).
   */
  whole: boolean;
}

/** Whether responses' bodies are recorded: with the request's details, unless bodies aren't. */
export function capturesResponse(tracepanel: Runtime): boolean {
  return tracepanel.config.captureRequest && bodyLimit() > 0;
}

/** The body of a response, its start kept as it passed, its size counted. */
export class ResponseTap {
  private readonly kept: Buffer[] = [];
  private keptSize = 0;
  private size = 0;
  private pieces = 0;
  /** Bytes put into the body on its way out (the widget's script in a page): not the app's. */
  private added = 0;
  private ended = false;
  /** How many bytes are kept: decided at the first piece, from what the headers say then. */
  private keep: number | undefined;

  /** `sent`: the response's headers as they are when asked. */
  constructor(private readonly sent: () => Sent) {}

  /** A piece of the body on its way to the client. */
  feed(chunk: unknown, encoding?: BufferEncoding): void {
    if (this.ended) return;
    const size = byteLength(chunk, encoding);
    if (size === 0) return;
    this.pieces += 1;
    this.size += size;
    this.keep ??= keeping(this.sent());
    const room = this.keep - this.keptSize;
    if (room <= 0) return;
    const piece = toBuffer(chunk, encoding);
    if (!piece) return;
    // A copy: the piece is the app's, and it may reuse its memory.
    const copy = Buffer.from(piece.subarray(0, room));
    this.kept.push(copy);
    this.keptSize += copy.length;
  }

  /** Bytes the SDK put into the body (the widget's script in a page): its size is the app's without them. */
  addedBy(bytes: number): void {
    this.added += bytes;
  }

  /** The body went out to its end. */
  end(): void {
    this.ended = true;
  }

  /**
   * http.response.body of a body sent whole, and http.response.body.size in bytes (as far as it went by then). A
   * stream, a compressed body, a page and its assets, binary content and JSON too large to mask: their size only.
   */
  attrs(): Attrs {
    if (bodyLimit() === 0) return {};
    const sent = this.sent();
    const found: Attrs = { "http.response.body.size": Math.max(0, this.size - this.added) };
    const kind = kindOf(sent.contentType);
    if (this.size === 0 || !this.ended || !wholeKind(sent)) return found;
    // In pieces without a declared size: a stream, written as it was made.
    if (this.pieces > 1 && !sent.whole) return found;
    const structured = isJson(kind) || kind === "application/x-www-form-urlencoded";
    if (structured && this.size > MAX_PARSED) return found;
    const data = Buffer.concat(this.kept);
    const text = readable(sent.contentType, data.toString("utf8"));
    if (text === undefined) return found;
    const body = cut(text, "http.response.body");
    // Its start only was kept: the rest is cut.
    if (this.size > data.length && "http.response.body" in body) body["http.response.body.truncated"] = true;
    return { ...body, ...found };
  }
}

/** Whether a body of this kind may be recorded, sent whole: text, not a page's, not compressed, not a stream. */
function wholeKind(sent: Sent): boolean {
  const kind = kindOf(sent.contentType);
  const encoding = sent.encoding.trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") return false;
  if (SHOWN_ELSEWHERE.has(kind) || STREAMED.has(kind) || kind.startsWith("multipart/")) return false;
  return readable(sent.contentType, "") !== undefined;
}

/** How much of a body is kept: a structure whole (up to MAX_PARSED and a byte), text up to the limit; else none. */
function keeping(sent: Sent): number {
  if (!wholeKind(sent)) return 0;
  const kind = kindOf(sent.contentType);
  if (isJson(kind) || kind === "application/x-www-form-urlencoded") return MAX_PARSED + 1;
  // The limit is in characters: up to four bytes each, and a byte past them to know the text was cut.
  return bodyLimit() * 4 + 1;
}

function byteLength(chunk: unknown, encoding?: BufferEncoding): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk, encoding);
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer | undefined {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === "string") return Buffer.from(chunk, encoding);
  return undefined;
}

type Write = ServerResponse["write"];
type End = ServerResponse["end"];
type WriteHead = ServerResponse["writeHead"];

/** A header's value among those passed to writeHead() (an object, or raw pairs), by its lower-case name. */
function passedHeader(passed: unknown, name: string): string | undefined {
  if (Array.isArray(passed)) {
    const pairs: unknown[][] = Array.isArray(passed[0])
      ? (passed as unknown[][])
      : Array.from({ length: Math.floor(passed.length / 2) }, (_, at) => [passed[2 * at], passed[2 * at + 1]]);
    const found = pairs.find(([key]) => String(key).toLowerCase() === name);
    return found ? headerValue(found[1]) : undefined;
  }
  if (passed !== null && typeof passed === "object") {
    const found = Object.entries(passed).find(([key]) => key.toLowerCase() === name);
    return found ? headerValue(found[1]) : undefined;
  }
  return undefined;
}

/**
 * A Node response whose body pieces pass the tap on their way out: what the app (or its framework) writes with
 * `write()` and `end()`, `pipe()` too. Headers passed to `writeHead()` itself count, as Node keeps none of them.
 */
export function tapResponse(res: ServerResponse): ResponseTap {
  const before = (res as ServerResponse & { [TAP]?: ResponseTap })[TAP];
  if (before) return before;
  let passed: unknown;
  const header = (name: string) => headerValue(res.getHeader(name)) ?? passedHeader(passed, name);
  const tap = new ResponseTap(() => ({
    contentType: header("content-type") ?? "",
    encoding: header("content-encoding") ?? "",
    whole: header("content-length") !== undefined,
  }));
  const writeHead = res.writeHead;
  const write = res.write;
  const end = res.end;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    const given = args.find((arg) => arg !== null && typeof arg === "object");
    if (given !== undefined) passed = given;
    return (writeHead as (...params: unknown[]) => ServerResponse).apply(this, args);
  } as WriteHead;
  res.write = function (this: ServerResponse, ...args: unknown[]) {
    try {
      tap.feed(args[0], typeof args[1] === "string" ? (args[1] as BufferEncoding) : undefined);
    } catch {
      // The response goes out whatever the tap makes of it.
    }
    return (write as (...params: unknown[]) => boolean).apply(this, args);
  } as Write;
  res.end = function (this: ServerResponse, ...args: unknown[]) {
    try {
      if (typeof args[0] !== "function") {
        tap.feed(args[0], typeof args[1] === "string" ? (args[1] as BufferEncoding) : undefined);
      }
      tap.end();
    } catch {
      // The response goes out whatever the tap makes of it.
    }
    return (end as (...params: unknown[]) => ServerResponse).apply(this, args);
  } as End;
  (res as ServerResponse & { [TAP]?: ResponseTap })[TAP] = tap;
  return tap;
}

/** Bytes the SDK put into a Node response's body (the widget's script in a page): not counted in its size. */
export function addedToResponse(res: ServerResponse, bytes: number): void {
  if (bytes > 0) (res as ServerResponse & { [TAP]?: ResponseTap })[TAP]?.addedBy(bytes);
}

/**
 * Node's HTTP server instrumentation's hook, as each request starts with its response: the response's body is
 * tapped, and its trace reads it as it ends.
 */
export function responseHook(tracepanel: Runtime): (span: Span, response: unknown) => void {
  return (span, response) => {
    // A server's response has writeHead(); an outgoing call's response (an IncomingMessage) has none.
    if (!capturesResponse(tracepanel) || typeof (response as ServerResponse).writeHead !== "function") return;
    const tap = tapResponse(response as ServerResponse);
    tracepanel.processor.readResponse(() => tap.attrs(), span.spanContext().spanId);
  };
}

/**
 * A fetch Response's body through the tap, piece by piece as the client reads it: nothing read ahead of it. `ended`
 * settles once the body has gone out, or the client went away.
 */
export function tapFetchBody(
  body: ReadableStream<Uint8Array>,
  tap: ResponseTap,
): { body: ReadableStream<Uint8Array>; ended: Promise<void> } {
  let ended = () => {};
  const done = new Promise<void>((resolve) => (ended = resolve));
  const reader = body.getReader();
  const through = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done: over, value } = await reader.read();
          if (over) {
            tap.end();
            controller.close();
            ended();
            return;
          }
          try {
            tap.feed(value);
          } catch {
            // The response goes out whatever the tap makes of it.
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          ended();
        }
      },
      async cancel(reason) {
        ended();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { body: through, ended: done };
}

/** A tap on a fetch Response's body, its headers as they are. */
export function fetchTap(headers: Headers): ResponseTap {
  return new ResponseTap(() => ({
    contentType: headers.get("content-type") ?? "",
    encoding: headers.get("content-encoding") ?? "",
    whole: true,
  }));
}
