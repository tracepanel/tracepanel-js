// A request's body as the app reads it, for the frameworks that read it from the stream themselves (Next.js, Nuxt,
// Bun.serve and the handlers under `withTracepanel()`): a tap sees each piece on its way to the app and keeps a copy
// of the start, up to the most a trace keeps. It never reads the stream itself: a body the app doesn't read is not
// recorded, and nothing waits for it. The app gets every byte as it came, at the pace it reads them, so an upload
// still streams; the tap never holds more than MAX_BODY bytes of it.
//
// MAX_BODY here is bodyLimit(): TRACEPANEL_MAX_BODY_KB, none with TRACEPANEL_CAPTURE_BODY=0.
//
// A multipart form is read as it passes: its fields' values (up to MAX_BODY in all), and its files by name and size,
// counted, never kept. JSON or a URL-encoded form past MAX_BODY isn't recorded: its secrets can't be masked from a
// part of it. Text past it is cut.

import type { ClientRequest, IncomingMessage } from "node:http";
import type { Span } from "@opentelemetry/api";
import { GRAPHQL_MAX, type GraphqlOperation, graphqlOperationOfBody, graphqlOperationOfQuery } from "./browser.js";
import type { Attrs } from "./model.js";
import { bodyLimit, cut, formText, hasBody, headerValue, kindOf, type RequestHeaders, readBody } from "./request.js";
import type { Runtime } from "./runtime.js";

const TAP = Symbol.for("tracepanel.body");
/** How long a part's headers may be before a form isn't read as one. */
const MAX_PART_HEADERS = 16_384;
const HEADERS_END = Buffer.from("\r\n\r\n");

/** A multipart form's fields and files, read from its pieces as they pass, the files' contents counted, not kept. */
class Multipart {
  readonly fields: [string, string][] = [];
  readonly files: [string, string, number][] = [];
  /** Some of the form was left out: past MAX_BODY. */
  overflow = false;
  done = false;
  private broken = false;
  private readonly delimiter: Buffer;
  // The first boundary comes without the line break before it: one goes in front, so every boundary looks alike.
  private pending: Buffer = Buffer.from("\r\n");
  private state: "body" | "after" | "headers" = "body";
  private part: { name: string; filename: string | undefined; size: number; value: Buffer[] } | undefined;
  private budget = bodyLimit() + 1;

  constructor(boundary: string) {
    this.delimiter = Buffer.from(`\r\n--${boundary}`);
  }

  feed(chunk: Buffer): void {
    if (this.done || this.broken) return;
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.state === "body") {
        const at = this.pending.indexOf(this.delimiter);
        if (at < 0) {
          // All but what could be the start of a boundary is the part's.
          const safe = Math.max(0, this.pending.length - this.delimiter.length + 1);
          this.take(this.pending.subarray(0, safe));
          this.pending = this.pending.subarray(safe);
          return;
        }
        this.take(this.pending.subarray(0, at));
        this.close();
        this.pending = this.pending.subarray(at + this.delimiter.length);
        this.state = "after";
      }
      if (this.state === "after") {
        if (this.pending.length < 2) return;
        if (this.pending[0] === 0x2d && this.pending[1] === 0x2d) {
          this.done = true;
          this.pending = Buffer.alloc(0);
          return;
        }
        this.state = "headers";
      }
      const end = this.pending.indexOf(HEADERS_END);
      if (end < 0) {
        if (this.pending.length > MAX_PART_HEADERS) this.broken = true;
        return;
      }
      this.open(this.pending.subarray(0, end).toString("utf8"));
      this.pending = this.pending.subarray(end + HEADERS_END.length);
      this.state = "body";
    }
  }

  /** The part's headers, the rest of the boundary's line before them. */
  private open(block: string): void {
    const disposition = block
      .split("\r\n")
      .slice(1)
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    const params = parameters(disposition?.slice(disposition.indexOf(":") + 1) ?? "");
    const { name, filename } = params;
    this.part = undefined;
    if (name === undefined) return;
    // Its names count toward what the form keeps, as its values do.
    const cost = name.length + (filename?.length ?? 0);
    if (cost > this.budget) {
      this.overflow = true;
      return;
    }
    this.budget -= cost;
    this.part = { name, filename, size: 0, value: [] };
  }

  private take(bytes: Buffer): void {
    const part = this.part;
    if (!part || bytes.length === 0) return;
    part.size += bytes.length;
    if (part.filename !== undefined) return;
    const kept = bytes.subarray(0, Math.max(0, this.budget));
    if (kept.length < bytes.length) this.overflow = true;
    // A copy: the piece is the app's, and it may reuse its memory.
    if (kept.length > 0) part.value.push(Buffer.from(kept));
    this.budget -= kept.length;
  }

  private close(): void {
    const part = this.part;
    this.part = undefined;
    if (!part) return;
    if (part.filename !== undefined) this.files.push([part.name, part.filename, part.size]);
    else this.fields.push([part.name, Buffer.concat(part.value).toString("utf8")]);
  }
}

/** A header's parameters (`form-data; name="a"; filename="b.png"`), `filename*` decoded and preferred. */
function parameters(header: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of header.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : (match[3] ?? "").trim();
    if (name === "filename*") {
      const encoded = value.replace(/^[^']*'[^']*'/, "");
      try {
        found.filename = decodeURIComponent(encoded);
      } catch {
        found.filename = encoded;
      }
    } else if (!(name in found)) found[name] = value;
  }
  return found;
}

/** The boundary a multipart form's Content-Type names. */
function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

/**
 * Whether a request's body may carry a GraphQL operation (JSON, or a document as `application/graphql`) small enough
 * to read for it. Its body is tapped for that whether or not bodies are recorded: only its start is kept, up to
 * GRAPHQL_MAX, and only its operation's type and name are recorded from it.
 */
export function mayCarryOperation(contentType: string, length: string | undefined): boolean {
  const kind = kindOf(contentType);
  if (!(kind === "application/json" || kind.endsWith("+json") || kind === "application/graphql")) return false;
  return length === undefined || length === "" || Number(length) <= GRAPHQL_MAX;
}

/** Whether a Node request's body is tapped: it is recorded, or it may carry a GraphQL operation. */
export function tapsBody(captureRequest: boolean, requested: RequestHeaders): boolean {
  if (!hasBody(requested)) return false;
  return (
    captureRequest ||
    mayCarryOperation(headerValue(requested["content-type"]) ?? "", headerValue(requested["content-length"]))
  );
}

/** What the app read of a request's body, kept as it passed: its start, its size, and whether it read it all. */
export class BodyTap {
  private readonly kept: Buffer[] = [];
  private size = 0;
  private ended = false;
  private readonly form: Multipart | undefined;
  /** How many bytes are kept: a byte past what a body or an operation is read from, to know it was cut. */
  private readonly keep: number;
  /** How much of a body is recorded: bodyLimit() as the request came. */
  private readonly limit: number;

  constructor(private readonly contentType: string) {
    const boundary = kindOf(contentType) === "multipart/form-data" ? boundaryOf(contentType) : undefined;
    this.form = boundary ? new Multipart(boundary) : undefined;
    this.limit = bodyLimit();
    this.keep = (mayCarryOperation(contentType, undefined) ? Math.max(this.limit, GRAPHQL_MAX) : this.limit) + 1;
  }

  /** A piece of the body on its way to the app. */
  feed(chunk: unknown): void {
    // Read again after it ended (Next.js hands a middleware's copy of the body to the route): counted once.
    if (this.ended) return;
    const piece = toBuffer(chunk);
    if (!piece || piece.length === 0) return;
    if (this.form) this.form.feed(piece);
    // Kept up to the limit, and a byte past it to know it was cut; never the rest of an upload.
    else if (this.size < this.keep) this.kept.push(Buffer.from(piece.subarray(0, this.keep - this.size)));
    this.size += piece.length;
  }

  /** The app read the body to its end. */
  end(): void {
    this.ended = true;
  }

  /** http.request.body, as far as the app read it. */
  attrs(): Attrs {
    if (this.form) {
      if (!this.form.done) return {};
      const text = formText(this.form.fields, this.form.files);
      if (!text) return {};
      return this.form.overflow ? { ...cut(text), "http.request.body.truncated": true } : cut(text);
    }
    const all = Buffer.concat(this.kept);
    const data = all.length > this.limit + 1 ? all.subarray(0, this.limit + 1) : all;
    const found = readBody(this.contentType, data, this.ended && this.size <= this.limit);
    // Its characters more than one byte each, the body was cut before MAX_BODY characters.
    if ("http.request.body" in found && this.size > data.length) found["http.request.body.truncated"] = true;
    return found;
  }

  /**
   * The GraphQL operation the body carried, once it all passed: the app read it, or Node let it go after the response
   * (a request answered before the app read it, a 503). None for a body cut at GRAPHQL_MAX.
   */
  operation(): GraphqlOperation | undefined {
    if (this.form || !this.ended || this.size >= this.keep) return undefined;
    return graphqlOperationOfBody(Buffer.concat(this.kept).toString("utf8"), this.contentType);
  }
}

/** A Node request's GraphQL operation as it is known at the time: its query string's (GET), its body's (tapped). */
export function incomingOperation(req: IncomingMessage): (() => GraphqlOperation | undefined) | undefined {
  const url = req.url ?? "/";
  const at = url.indexOf("?");
  if (req.method === "GET") {
    return at >= 0 && url.includes("query=", at) ? () => graphqlOperationOfQuery(url.slice(at)) : undefined;
  }
  const tap = tapOf(req);
  return tap ? () => tap.operation() : undefined;
}

/**
 * Node's HTTP server instrumentation's hook, as each request starts: its body is tapped (before the app reads it) when
 * it may carry a GraphQL operation, and its trace reads the operation from it, or from its query string.
 */
export function operationHook(tracepanel: Runtime): (span: Span, request: ClientRequest | IncomingMessage) => void {
  return (span, request) => {
    // An incoming request has its headers as they came; an outgoing one (a ClientRequest) has none.
    if (!("headers" in request)) return;
    if (!tapOf(request) && tapsBody(tracepanel.config.captureRequest, request.headers)) tapIncoming(request);
    const read = incomingOperation(request);
    if (read) tracepanel.processor.readOperation(read, span.spanContext().spanId);
  };
}

/** A fetch Request's GraphQL operation, as incomingOperation() reads a Node request's. */
export function fetchOperation(
  request: Request,
  tap: BodyTap | undefined,
): (() => GraphqlOperation | undefined) | undefined {
  if (request.method === "GET") {
    const search = new URL(request.url).search;
    return search.includes("query=") ? () => graphqlOperationOfQuery(search) : undefined;
  }
  return tap ? () => tap.operation() : undefined;
}

/** Whether a fetch Request's body is tapped, as tapsBody() tells a Node request's. */
export function tapsFetchBody(captureRequest: boolean, request: Request): boolean {
  return (
    captureRequest ||
    mayCarryOperation(request.headers.get("content-type") ?? "", request.headers.get("content-length") ?? undefined)
  );
}

function toBuffer(chunk: unknown): Buffer | undefined {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === "string") return Buffer.from(chunk);
  return undefined;
}

type Emit = IncomingMessage["emit"];

/**
 * A Node request whose body pieces pass the tap on their way to the app: every reader of a stream (a `data`
 * listener, `read()`, async iteration, `pipe()`) gets them through its `emit("data")`. The tap is the request's from
 * then on (`tapOf`). A framework that puts another stream's `emit` on the request (Next.js does, for a body a
 * middleware read too) gets it tapped as well.
 */
export function tapIncoming(req: IncomingMessage): BodyTap {
  const tap = new BodyTap(headerValue(req.headers["content-type"]) ?? "");
  let emit: Emit = req.emit;
  const tapped = function (this: IncomingMessage, event: string | symbol, ...args: unknown[]) {
    try {
      if (event === "data") tap.feed(args[0]);
      else if (event === "end") tap.end();
    } catch {
      // The app's body goes on whatever the tap makes of it.
    }
    return emit.call(this, event, ...args);
  } as Emit;
  Object.defineProperty(req, "emit", {
    configurable: true,
    get: () => tapped,
    set: (value: Emit) => {
      emit = value;
    },
  });
  (req as IncomingMessage & { [TAP]?: BodyTap })[TAP] = tap;
  return tap;
}

/** The tap on a Node request's body, if it has one. */
export function tapOf(req: IncomingMessage | undefined): BodyTap | undefined {
  return (req as (IncomingMessage & { [TAP]?: BodyTap }) | undefined)?.[TAP];
}

const READERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;

/** The getter a property has on an object's prototypes: the Request's own `body`, under the tap's. */
function inherited(target: object, name: string): ((this: unknown) => unknown) | undefined {
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const found = Object.getOwnPropertyDescriptor(proto, name);
    if (found) return found.get;
  }
  return undefined;
}

/**
 * A fetch Request whose body passes the tap on its way to the handler: `request.body` and its readers (`text()`,
 * `json()`, `formData()`, ...) read through it, piece by piece as the handler pulls them. The request stays the one
 * the server made (Bun's `params` and `cookies` with it); `clone()` is its own, untapped.
 */
export function tapRequest(request: Request): BodyTap | undefined {
  // Tapped already, by a withTracepanel() around this one: the same tap.
  const before = (request as Request & { [TAP]?: BodyTap })[TAP];
  if (before) return before;
  const original = inherited(request, "body");
  // A request without a body (a GET) keeps its null; a fetch Request's headers have no Content-Length to tell.
  if (!original || original.call(request) === null) return undefined;
  const tap = new BodyTap(request.headers.get("content-type") ?? "");
  let through: ReadableStream<Uint8Array> | undefined;
  const body = (): ReadableStream<Uint8Array> | null => {
    if (through) return through;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // The request's own stream, taken at the first read: until then it is the app's to clone.
    const source = () => {
      if (reader) return reader;
      const stream = original.call(request) as ReadableStream<Uint8Array> | null;
      reader = stream?.getReader();
      return reader;
    };
    through = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const from = source();
          const { done, value } = from ? await from.read() : { done: true, value: undefined };
          if (done || !value) {
            tap.end();
            controller.close();
            return;
          }
          try {
            tap.feed(value);
          } catch {
            // The handler's body goes on whatever the tap makes of it.
          }
          controller.enqueue(value);
        },
        async cancel(reason) {
          await source()?.cancel(reason);
        },
      },
      // Nothing read ahead of the handler: a piece is taken when it asks for one.
      { highWaterMark: 0 },
    );
    return through;
  };
  (request as Request & { [TAP]?: BodyTap })[TAP] = tap;
  const headers = { "content-type": request.headers.get("content-type") ?? "" };
  Object.defineProperty(request, "body", { configurable: true, get: body });
  for (const name of READERS) {
    if (typeof (request as unknown as Record<string, unknown>)[name] !== "function") continue;
    Object.defineProperty(request, name, {
      configurable: true,
      writable: true,
      // A promise either way, as the request's own: a body already read rejects it.
      value: async () =>
        (new Response(body(), { headers }) as unknown as Record<string, () => Promise<unknown>>)[name]?.(),
    });
  }
  return tap;
}
