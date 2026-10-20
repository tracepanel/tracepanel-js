// `app.use(tracepanel())`: a page ended at once gets the widget's script into its whole body; one streamed in pieces
// gets it as they pass, with the badge's headers sent before the first.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import express from "express";
import { afterAll, expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { tracepanel as middleware } from "../src/express.js";
import type { TracepanelProcessor } from "../src/processor.js";
import type { Runtime } from "../src/runtime.js";
import { badge } from "../src/widget.js";

const KEY = Symbol.for("tracepanel.runtime");
const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

/** The process's Tracepanel with its agent's console running, the request being answered trace 01TRACE. */
const processor = {
  timing: () => ({ id: "01TRACE", queries: 2, dbMs: 1.5, startedMs: performance.now() }),
  framework: () => "Express",
  setFramework: () => {},
} as unknown as TracepanelProcessor;
const tracepanel: Runtime = {
  config: { ...loadConfig({}), enabled: true },
  processor,
  starter: {} as Starter,
  console: { get: () => "http://127.0.0.1:9/" } as unknown as ConsoleUrl,
  badge: (request) => badge(tracepanel, request),
};
(globalThis as Record<symbol, unknown>)[KEY] = tracepanel;

// The streamed page waits here after its first piece, until the client has read it.
let firstRead: () => void = () => {};
const app = express();
app.use(middleware());
app.get("/page", (_req, res) => {
  res.type("html").send(PAGE);
});
app.get("/streamed", async (_req, res) => {
  res.type("html");
  res.write("<!doctype html><html><he");
  await new Promise<void>((resolve) => (firstRead = resolve));
  res.write("ad><title>t</title></head>");
  res.end("<body>x</body></html>");
});
app.get("/compressed", (_req, res) => {
  const body = gzipSync(PAGE);
  res.type("html").setHeader("Content-Encoding", "gzip");
  res.write(body.subarray(0, 10));
  res.end(body.subarray(10));
});
app.get("/events", (_req, res) => {
  res.type("text/event-stream");
  res.write("data: 1\n\n");
  res.end("data: 2\n\n");
});
const server: Server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => server.close());

const SCRIPT = expect.stringMatching(/^<script src="http:\/\/127\.0\.0\.1:9\/widget\.min\.js" [^>]*><\/script>$/);

function badgeHeaders(response: Response): Record<string, string | null> {
  const names = ["tracepanel-id", "tracepanel-url", "server-timing", "content-length", "transfer-encoding"];
  return Object.fromEntries(names.map((name) => [name, response.headers.get(name)]));
}

test("a page ended at once gets the script first in its head, and its new size", async () => {
  const response = await fetch(`${base}/page`);
  const body = await response.text();
  const [before, script, after] = body.split(/(<script .*?<\/script>)/);

  expect(badgeHeaders(response)).toEqual({
    "tracepanel-id": "01TRACE",
    "tracepanel-url": "http://127.0.0.1:9/#/t/01TRACE",
    "server-timing": expect.stringMatching(/^db;dur=1\.5;desc="2 queries", app;dur=.*, total;dur=/),
    "content-length": String(Buffer.byteLength(body)),
    "transfer-encoding": null,
  });

  expect([before, script, after]).toEqual([
    "<!doctype html><html><head>",
    SCRIPT,
    "<title>t</title></head><body>x</body></html>",
  ]);
});

test("a streamed page goes out as it comes, the badge's headers first and the script as its head passes", async () => {
  const response = await fetch(`${base}/streamed`);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  firstRead();
  let rest = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) rest += decoder.decode(read.value);
  const [before, script, after] = (first + rest).split(/(<script .*?<\/script>)/);

  expect(badgeHeaders(response)).toEqual({
    "tracepanel-id": "01TRACE",
    "tracepanel-url": "http://127.0.0.1:9/#/t/01TRACE",
    "server-timing": expect.stringMatching(/^db;dur=1\.5;desc="2 queries", app;dur=.*, total;dur=/),
    "content-length": null,
    "transfer-encoding": "chunked",
  });

  // Only the tag cut between the pieces waited: what came before it was out already.
  expect(first).toBe("<!doctype html><html>");

  expect([before, script, after]).toEqual([
    "<!doctype html><html><head>",
    SCRIPT,
    "<title>t</title></head><body>x</body></html>",
  ]);
});

test("a compressed page streamed is left as it is, with the badge's headers", async () => {
  const response = await fetch(`${base}/compressed`);

  expect([response.headers.get("tracepanel-id"), await response.text()]).toEqual(["01TRACE", PAGE]);
});

test("events streamed get the badge's headers and pass unchanged", async () => {
  const response = await fetch(`${base}/events`);

  expect([response.headers.get("tracepanel-id"), await response.text()]).toEqual(["01TRACE", "data: 1\n\ndata: 2\n\n"]);
});
