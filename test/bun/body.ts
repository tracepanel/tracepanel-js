// Run by Bun itself (`bun test/bun/body.ts`, in CI's Bun job): Bun.serve's own requests, through serve() and a Hono
// app under withTracepanel(), read their bodies through the tap. The handler gets every byte and the route's
// parameters; the trace gets the body as the handler read it. A response's body passes a tap on its way out: one
// sent whole is recorded, its secrets masked and cut at the limit; a stream by its size only, sent as it is made.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { serve, withTracepanel } from "../../src/bun.js";
import { loadConfig } from "../../src/config.js";
import type { Attrs } from "../../src/model.js";
import type { TracepanelProcessor } from "../../src/processor.js";
import { MAX_BODY } from "../../src/request.js";
import type { Runtime } from "../../src/runtime.js";

const recorded: Attrs[] = [];
/** Where the last response's body is read from, as its trace ends. */
let response: (() => Attrs) | undefined;
const processor = {
  timing: () => ({ id: "01TRACE", queries: 0, dbMs: 0, startedMs: performance.now() }),
  framework: () => "Bun.serve",
  setFramework: () => {},
  setTraceAttrs: (attrs: Attrs) => recorded.push(attrs),
  readOperation: () => {},
  readResponse: (read: () => Attrs) => {
    response = read;
  },
} as unknown as TracepanelProcessor;
const tracepanel = {
  config: { ...loadConfig({}), enabled: true },
  processor,
  badge: () => undefined,
} as unknown as Runtime;
// Started already: the handlers are wrapped without hooking the process.
Object.assign(globalThis, { [Symbol.for("tracepanel.runtime")]: tracepanel, [Symbol.for("tracepanel.started")]: true });

function body(): Attrs {
  const last = recorded.at(-1) ?? {};
  return Object.fromEntries(Object.entries(last).filter(([name]) => name.startsWith("http.request.body")));
}

// The stream's second event waits here until the client has read the first.
let release: () => void = () => {};
const firstRead = new Promise<void>((resolve) => (release = resolve));

const hono = new Hono();
hono.post("/hono/books", async (c) => c.text(`added ${((await c.req.json()) as { title: string }).title}`));

type Routed = Request & { params: { id: string } };
const server = serve({
  port: 0,
  routes: {
    "/books/:id": {
      POST: async (request: Request) => {
        const form = await request.formData();
        const cover = form.get("cover");
        return new Response(`${(request as Routed).params.id} ${form.get("title")} ${(cover as File).size}`);
      },
    },
    "/upload": async (request: Request) => {
      const hash = createHash("sha256");
      let size = 0;
      for await (const piece of request.body as ReadableStream<Uint8Array>) {
        size += piece.length;
        hash.update(piece);
      }
      return new Response(`${size} ${hash.digest("hex")}`);
    },
    "/ignored": () => new Response("not read"),
    "/account": () => Response.json({ id: "7", password: "hunter2" }),
    "/large": () => new Response("x".repeat(MAX_BODY + 100), { headers: { "Content-Type": "text/plain" } }),
    "/events": () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("data: 1\n\n"));
          await firstRead;
          controller.enqueue(encoder.encode("data: 2\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  },
  fetch: withTracepanel(hono.fetch),
}) as { port: number; stop(force?: boolean): void };
const base = `http://127.0.0.1:${server.port}`;

try {
  const form = new FormData();
  form.set("title", "Dune");
  form.set("password", "p");
  form.set("cover", new File([new Uint8Array(3 * MAX_BODY)], "dune.png"));
  const routed = await fetch(`${base}/books/7`, { method: "POST", body: form });
  assert.equal(await routed.text(), `7 Dune ${3 * MAX_BODY}`);
  assert.deepEqual(body(), {
    "http.request.body": `title=Dune&password=********&cover=<file dune.png, ${3 * MAX_BODY} bytes>`,
  });

  const pieces = Array.from({ length: 64 }, (_, at) => new Uint8Array(64 * 1024).fill(97 + (at % 26)));
  const sent = createHash("sha256");
  for (const piece of pieces) sent.update(piece);
  const upload = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: new Blob(pieces),
  });
  assert.equal(await upload.text(), `${64 * 64 * 1024} ${sent.digest("hex")}`);
  assert.deepEqual(body(), { "http.request.body": "a".repeat(MAX_BODY), "http.request.body.truncated": true });

  const ignored = await fetch(`${base}/ignored`, { method: "POST", body: '{"a":1}' });
  assert.equal(await ignored.text(), "not read");
  assert.deepEqual(body(), {});

  const json = await fetch(`${base}/hono/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"title":"Dune","token":"t"}',
  });
  assert.equal(await json.text(), "added Dune");
  assert.deepEqual(body(), { "http.request.body": '{"title":"Dune","token":"********"}' });

  const account = await fetch(`${base}/account`);
  assert.deepEqual(await account.json(), { id: "7", password: "hunter2" });
  assert.deepEqual(response?.(), {
    "http.response.body": '{"id":"7","password":"********"}',
    "http.response.body.size": 31,
  });

  const large = await fetch(`${base}/large`);
  assert.equal((await large.text()).length, MAX_BODY + 100);
  assert.deepEqual(response?.(), {
    "http.response.body": "x".repeat(MAX_BODY),
    "http.response.body.truncated": true,
    "http.response.body.size": MAX_BODY + 100,
  });

  const events = await fetch(`${base}/events`);
  const reader = (events.body as ReadableStream<Uint8Array>).getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  release();
  let rest = "";
  for (let piece = await reader.read(); !piece.done; piece = await reader.read())
    rest += new TextDecoder().decode(piece.value);
  assert.equal(first + rest, "data: 1\n\ndata: 2\n\n");
  assert.deepEqual(response?.(), { "http.response.body.size": 18 });

  // biome-ignore lint/suspicious/noConsole: the script's result, for CI's log
  console.log("Bun.serve bodies recorded");
} finally {
  server.stop(true);
}
