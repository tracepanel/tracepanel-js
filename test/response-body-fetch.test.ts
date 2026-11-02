// A response's body where the framework answers from its own server (Next.js route handlers, through the server's
// response) or a fetch handler (Bun.serve, Hono on Bun, through withTracepanel()): one sent whole is recorded with its
// secrets masked and cut at the limit, a stream by its size only, going out as it is made; nothing with bodies off.
// And the tap's rules: a page, a compressed body, binary content or JSON too large to mask by their size only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { withTracepanel } from "../src/bun.js";
import { loadConfig } from "../src/config.js";
import { headersOnResponses } from "../src/headers.js";
import type { Attrs } from "../src/model.js";
import type { TracepanelProcessor } from "../src/processor.js";
import { limitBodies, MAX_BODY } from "../src/request.js";
import { fetchTap, MAX_PARSED, ResponseTap, type Sent } from "../src/response-body.js";
import type { Runtime } from "../src/runtime.js";

const KEY = Symbol.for("tracepanel.runtime");
// Started already: the test's handlers are wrapped without hooking the process.
const STARTED = Symbol.for("tracepanel.started");

const ACCOUNT = { id: "7", password: "hunter2", owner: { apiKey: "k1", name: "Ann" } };
const MASKED = '{"id":"7","password":"********","owner":{"apiKey":"********","name":"Ann"}}';
const LARGE = "x".repeat(MAX_BODY + 100);
const EVENTS = ["data: 1\n\n", "data: 2\n\n"];

/** Where the last request's response body is read from, as the processor is given it. */
let reader: (() => Attrs) | undefined;
const processor = {
  framework: () => undefined,
  setFramework: () => {},
  setTraceAttrs: () => {},
  readOperation: () => {},
  readResponse: (read: () => Attrs) => {
    reader = read;
  },
  timing: () => undefined,
} as unknown as TracepanelProcessor;
const tracepanel: Runtime = {
  config: { ...loadConfig({}), enabled: true },
  processor,
  starter: {} as Starter,
  console: {} as ConsoleUrl,
  badge: () => undefined,
};
Object.assign(globalThis, { [KEY]: tracepanel, [STARTED]: true });

beforeEach(() => {
  reader = undefined;
  limitBodies({ captureBody: true, maxBodyKb: 64 });
});

/** The response body's attributes, as its trace reads them as it ends. */
function recorded(): Attrs | undefined {
  return reader?.();
}

// A stream's second event waits here until the client has read the first.
let release: () => void = () => {};
function firstRead(): Promise<void> {
  return new Promise((resolve) => (release = resolve));
}

function events(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(EVENTS[0]));
      await firstRead();
      controller.enqueue(encoder.encode(EVENTS[1]));
      controller.close();
    },
  });
}

/** The pieces of a body as the client reads them: the stream's second event only once it read the first. */
async function readEvents(body: ReadableStream<Uint8Array>): Promise<string> {
  const reading = body.getReader();
  const decoder = new TextDecoder();
  let read = decoder.decode((await reading.read()).value);
  release();
  for (;;) {
    const { done, value } = await reading.read();
    if (done) return read;
    read += decoder.decode(value);
  }
}

/** A route handler's Response as Next.js sends it through Node's response: each piece written, then the end. */
async function sendAsNext(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const piece of response.body) res.write(piece);
  res.end();
}

// app/api/<name>/route.ts
const routes: Record<string, () => Response> = {
  "/api/json": () => Response.json(ACCOUNT),
  "/api/large": () => new Response(LARGE, { headers: { "Content-Type": "text/plain" } }),
  "/api/events": () => new Response(events(), { headers: { "Content-Type": "text/event-stream" } }),
};
headersOnResponses(tracepanel, "Next.js");
const next: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void sendAsNext(routes[req.url ?? "/"]?.() ?? new Response(null, { status: 404 }), res);
});
await new Promise<void>((resolve) => next.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(next.address() as AddressInfo).port}`;

afterAll(() => {
  next.close();
});

describe("Next.js route handlers", () => {
  test("JSON sent whole is recorded with its size, its secrets masked", async () => {
    const response = await fetch(`${base}/api/json`);

    expect(await response.json()).toEqual(ACCOUNT);

    expect(recorded()).toEqual({
      "http.response.body": MASKED,
      "http.response.body.size": JSON.stringify(ACCOUNT).length,
    });
  });

  test("a body past the limit is cut there, and says so", async () => {
    const response = await fetch(`${base}/api/large`);

    expect(await response.text()).toBe(LARGE);

    expect(recorded()).toEqual({
      "http.response.body": "x".repeat(MAX_BODY),
      "http.response.body.truncated": true,
      "http.response.body.size": LARGE.length,
    });
  });

  test("a stream goes out as it is made, never held; its size only is recorded", async () => {
    const response = await fetch(`${base}/api/events`);

    expect(await readEvents(response.body as ReadableStream<Uint8Array>)).toBe(EVENTS.join(""));

    expect(recorded()).toEqual({ "http.response.body.size": EVENTS.join("").length });
  });

  test("with bodies off, none is recorded", async () => {
    limitBodies({ captureBody: false, maxBodyKb: 64 });
    const response = await fetch(`${base}/api/json`);

    expect(await response.json()).toEqual(ACCOUNT);

    expect(reader).toBeUndefined();
  });
});

// The handler the test gives, as a Hono route's.
let handled: () => Response = () => new Response(null, { status: 404 });
const hono = new Hono();
hono.all("*", () => handled());

describe.each([
  ["Bun.serve", (handler: () => Response) => withTracepanel(handler)],
  [
    "Hono on Bun",
    (handler: () => Response) => {
      handled = handler;
      return withTracepanel((request: Request) => hono.fetch(request));
    },
  ],
])("%s", (_name, wrap) => {
  test("JSON sent whole is recorded with its size, its secrets masked", async () => {
    const handler = wrap(() => Response.json(ACCOUNT));

    const response = await handler(new Request("http://localhost/books/7"));

    expect(await response.json()).toEqual(ACCOUNT);

    expect(recorded()).toEqual({
      "http.response.body": MASKED,
      "http.response.body.size": JSON.stringify(ACCOUNT).length,
    });
  });

  test("a body past the limit is cut there, and says so", async () => {
    const handler = wrap(() => new Response(LARGE, { headers: { "Content-Type": "text/plain" } }));

    const response = await handler(new Request("http://localhost/large"));

    expect(await response.text()).toBe(LARGE);

    expect(recorded()).toEqual({
      "http.response.body": "x".repeat(MAX_BODY),
      "http.response.body.truncated": true,
      "http.response.body.size": LARGE.length,
    });
  });

  test("a stream goes out as it is made, never held; its size only", async () => {
    const handler = wrap(() => new Response(events(), { headers: { "Content-Type": "text/event-stream" } }));

    const response = await handler(new Request("http://localhost/events"));

    expect(await readEvents(response.body as ReadableStream<Uint8Array>)).toBe(EVENTS.join(""));

    expect(recorded()).toEqual({ "http.response.body.size": EVENTS.join("").length });
  });

  test("with bodies off, none is recorded", async () => {
    limitBodies({ captureBody: false, maxBodyKb: 64 });
    const handler = wrap(() => Response.json(ACCOUNT));

    const response = await handler(new Request("http://localhost/books/7"));

    expect(await response.json()).toEqual(ACCOUNT);

    expect(reader).toBeUndefined();
  });
});

/** What a tap records of a body sent in these pieces, with these headers. */
function tapped(sent: Partial<Sent>, ...pieces: (string | Uint8Array)[]): Attrs {
  const tap = new ResponseTap(() => ({ contentType: "", encoding: "", whole: false, ...sent }));
  for (const piece of pieces) tap.feed(piece);
  tap.end();
  return tap.attrs();
}

describe("the tap", () => {
  test("a page, its assets, a compressed body and binary content: their size only", () => {
    const page = "<!doctype html><html></html>";

    expect(tapped({ contentType: "text/html; charset=utf-8" }, page)).toEqual({
      "http.response.body.size": page.length,
    });
    expect(tapped({ contentType: "text/css" }, "a{}")).toEqual({ "http.response.body.size": 3 });

    const zipped = gzipSync(JSON.stringify(ACCOUNT));
    expect(tapped({ contentType: "application/json", encoding: "gzip" }, zipped)).toEqual({
      "http.response.body.size": zipped.length,
    });

    expect(tapped({ contentType: "image/png" }, new Uint8Array([137, 80, 78, 71]))).toEqual({
      "http.response.body.size": 4,
    });
  });

  test("JSON too large to mask: its size only, and the tap keeps no more of it than MAX_PARSED and a byte", () => {
    const tap = new ResponseTap(() => ({ contentType: "application/json", encoding: "", whole: true }));
    const piece = Buffer.alloc(1 << 20, 0x20);
    for (let at = 0; at < 6; at += 1) tap.feed(piece);
    tap.end();

    expect(tap.attrs()).toEqual({ "http.response.body.size": 6 << 20 });

    const kept = (tap as unknown as { kept: Buffer[] }).kept;
    expect(kept.reduce((size, part) => size + part.length, 0)).toBe(MAX_PARSED + 1);
  });

  test("a Node body in pieces with its size declared is a whole, without one a stream; a fetch body's pieces don't tell", () => {
    const json = JSON.stringify(ACCOUNT);
    const [head, tail] = [json.slice(0, 10), json.slice(10)];

    expect(tapped({ contentType: "application/json", whole: true }, head, tail)).toEqual({
      "http.response.body": MASKED,
      "http.response.body.size": json.length,
    });

    expect(tapped({ contentType: "application/json" }, head, tail)).toEqual({ "http.response.body.size": json.length });

    // Bun hands a string's body over in several pieces.
    const fetched = fetchTap(new Headers({ "Content-Type": "application/json" }));
    fetched.feed(head);
    fetched.feed(tail);
    fetched.end();
    expect(fetched.attrs()).toEqual({ "http.response.body": MASKED, "http.response.body.size": json.length });
  });

  test("text, XML and JSON that isn't JSON as they are; an empty body by its size", () => {
    expect(tapped({ contentType: "application/atom+xml" }, "<feed/>")).toEqual({
      "http.response.body": "<feed/>",
      "http.response.body.size": 7,
    });
    expect(tapped({ contentType: "application/json" }, "{oops")).toEqual({
      "http.response.body": "{oops",
      "http.response.body.size": 5,
    });
    expect(tapped({ contentType: "application/json" })).toEqual({ "http.response.body.size": 0 });
  });

  test("a body that hasn't ended (the client went away): its size so far", () => {
    const tap = fetchTap(new Headers({ "Content-Type": "application/json" }));
    tap.feed('{"id":');

    expect(tap.attrs()).toEqual({ "http.response.body.size": 6 });
  });

  test("the limit is TRACEPANEL_MAX_BODY_KB's, in characters", () => {
    limitBodies({ captureBody: true, maxBodyKb: 1 });

    expect(tapped({ contentType: "text/plain" }, "é".repeat(2000))).toEqual({
      "http.response.body": "é".repeat(1024),
      "http.response.body.truncated": true,
      "http.response.body.size": 4000,
    });
  });
});
