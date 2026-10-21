// Run by Bun itself (`bun test/bun/body.ts`, in CI's Bun job): Bun.serve's own requests, through serve() and a Hono
// app under withTracepanel(), read their bodies through the tap. The handler gets every byte and the route's
// parameters; the trace gets the body as the handler read it.
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
const processor = {
  timing: () => ({ id: "01TRACE", queries: 0, dbMs: 0, startedMs: performance.now() }),
  framework: () => "Bun.serve",
  setFramework: () => {},
  setTraceAttrs: (attrs: Attrs) => recorded.push(attrs),
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

  // biome-ignore lint/suspicious/noConsole: the script's result, for CI's log
  console.log("Bun.serve bodies recorded");
} finally {
  server.stop(true);
}
