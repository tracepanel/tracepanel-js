// Nuxt's server (Nitro, on h3) reads a request's body from Node's stream for the handler: readBody, readFormData,
// readMultipartFormData, or the stream itself. Each piece passes the tap on its way, and the body goes into the trace
// as the response goes out, as far as the handler read it; the handler gets every byte, an upload still streams.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createApp,
  createRouter,
  defineEventHandler,
  readBody,
  readFormData,
  readMultipartFormData,
  toNodeListener,
} from "h3";
import { afterAll, beforeEach, expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import type { Attrs } from "../src/model.js";
import tracepanelPlugin from "../src/nuxt-plugin.js";
import type { TracepanelProcessor } from "../src/processor.js";
import { MAX_BODY } from "../src/request.js";
import type { Runtime } from "../src/runtime.js";

const KEY = Symbol.for("tracepanel.runtime");

/** What went into the trace's attributes, by the request's path. */
const recorded = new Map<string, Attrs>();
const processor = {
  framework: () => "Nuxt",
  setFramework: () => {},
  setRoute: () => {},
  setTraceAttrs: (attrs: Attrs, request: { url: string }) =>
    recorded.set(request.url, { ...recorded.get(request.url), ...attrs }),
} as unknown as TracepanelProcessor;
const tracepanel: Runtime = {
  config: { ...loadConfig({}), enabled: true },
  processor,
  starter: {} as Starter,
  console: {} as ConsoleUrl,
  badge: () => undefined,
};
(globalThis as Record<symbol, unknown>)[KEY] = tracepanel;
// The Nitro plugin, as the module adds it: its hooks are left unused here.
tracepanelPlugin({ hooks: { hook: () => {} } });

const router = createRouter()
  .post(
    "/api/books",
    defineEventHandler(async (event) => {
      const book = await readBody<{ title: string }>(event);
      return `added ${book.title}`;
    }),
  )
  .post(
    "/api/form",
    defineEventHandler(async (event) => {
      const form = await readFormData(event);
      const cover = form.get("cover");
      return `${form.get("title")} ${cover instanceof File ? `${cover.name} ${cover.size}` : "-"}`;
    }),
  )
  .post(
    "/api/multipart",
    defineEventHandler(async (event) => {
      const parts = (await readMultipartFormData(event)) ?? [];
      return parts.map((part) => `${part.name}:${part.filename ?? ""}:${part.data.length}`).join(" ");
    }),
  )
  .post(
    "/api/upload",
    defineEventHandler(async (event) => {
      const hash = createHash("sha256");
      let size = 0;
      await pipeline(
        event.node.req,
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            size += chunk.length;
            hash.update(chunk);
            done();
          },
        }),
      );
      return `${size} ${hash.digest("hex")}`;
    }),
  )
  .post(
    "/api/ignored",
    defineEventHandler(() => "not read"),
  );
const h3 = createApp();
h3.use(router);
const app: Server = createServer(toNodeListener(h3));
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

beforeEach(() => {
  recorded.clear();
});

afterAll(() => {
  app.close();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

function body(path: string): Attrs {
  return Object.fromEntries(
    Object.entries(recorded.get(path) ?? {}).filter(([name]) => name.startsWith("http.request.body")),
  );
}

test("readBody's JSON, as the handler read it, secrets masked", async () => {
  const answer = await fetch(`${base}/api/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Dune", owner: { name: "Ann", password: "p" } }),
  });

  expect(await answer.text()).toBe("added Dune");

  expect(body("/api/books")).toEqual({
    "http.request.body": '{"title":"Dune","owner":{"name":"Ann","password":"********"}}',
  });
});

test("readFormData's form: URL-encoded, or multipart with its file by name and size", async () => {
  const form = new FormData();
  form.set("title", "Dune");
  form.set("cover", new File([new Uint8Array(30_000)], "dune.png", { type: "image/png" }));

  const multipart = await fetch(`${base}/api/form`, { method: "POST", body: form });

  expect(await multipart.text()).toBe("Dune dune.png 30000");

  expect(body("/api/form")).toEqual({ "http.request.body": "title=Dune&cover=<file dune.png, 30000 bytes>" });

  const encoded = await fetch(`${base}/api/form`, {
    method: "POST",
    body: new URLSearchParams({ title: "Dune", token: "t" }),
  });

  expect(await encoded.text()).toBe("Dune -");

  expect(body("/api/form")).toEqual({ "http.request.body": "title=Dune&token=********" });
});

test("readMultipartFormData's parts: the handler gets the file whole, the trace its name and size", async () => {
  const form = new FormData();
  form.set("album", "summer");
  form.set("photo", new File([new Uint8Array(5 * MAX_BODY)], "beach.jpg"));

  const answer = await fetch(`${base}/api/multipart`, { method: "POST", body: form });

  expect(await answer.text()).toBe(`album::6 photo:beach.jpg:${5 * MAX_BODY}`);

  expect(body("/api/multipart")).toEqual({
    "http.request.body": `album=summer&photo=<file beach.jpg, ${5 * MAX_BODY} bytes>`,
  });
});

test("a large upload the handler streams goes through whole, and the trace keeps its start", async () => {
  const pieces = Array.from({ length: 64 }, (_, at) => Buffer.alloc(64 * 1024, 97 + (at % 26)));
  const whole = Buffer.concat(pieces);
  const upload = new ReadableStream({
    pull(controller) {
      const piece = pieces.shift();
      if (piece) controller.enqueue(piece);
      else controller.close();
    },
  });

  const answer = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: upload,
    duplex: "half",
  } as RequestInit);

  expect(await answer.text()).toBe(`${whole.length} ${createHash("sha256").update(whole).digest("hex")}`);

  expect(body("/api/upload")).toEqual({
    "http.request.body": "a".repeat(MAX_BODY),
    "http.request.body.truncated": true,
  });
});

test("a body the handler never reads is not recorded, nor waited for", async () => {
  const answer = await fetch(`${base}/api/ignored`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"a":1}',
  });

  expect(await answer.text()).toBe("not read");

  expect([recorded.has("/api/ignored"), body("/api/ignored")]).toEqual([true, {}]);
});
