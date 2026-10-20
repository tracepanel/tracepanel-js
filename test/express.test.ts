// `app.use(tracepanel())`: a page ended at once gets the widget's script into its whole body; one streamed in pieces
// gets it as they pass, with the badge's headers sent before the first. What the request carried goes into its trace,
// the body as far as a body parser read it; a form's redirect sets the cookie the next page's panel reads.
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import express from "express";
import { afterAll, expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { tracepanel as middleware } from "../src/express.js";
import type { Attrs } from "../src/model.js";
import type { TracepanelProcessor } from "../src/processor.js";
import type { Runtime } from "../src/runtime.js";
import { badge } from "../src/widget.js";

const KEY = Symbol.for("tracepanel.runtime");
const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

/** What went into the trace's attributes, by the last request. */
let recorded: Attrs = {};
/** The process's Tracepanel with its agent's console running, the request being answered trace 01TRACE. */
const processor = {
  timing: () => ({ id: "01TRACE", queries: 2, dbMs: 1.5, startedMs: performance.now() }),
  framework: () => "Express",
  setFramework: () => {},
  setTraceAttrs: (attrs: Attrs) => {
    recorded = attrs;
  },
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
app.post("/login", express.urlencoded(), (_req, res) => {
  res.cookie("sessionid", "s3cr3t").redirect(303, "/home");
});
app.post("/api/books", express.json(), (req, res) => {
  res.json({ title: req.body.title });
});
app.post("/raw", (_req, res) => {
  res.json({ read: false });
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

/** A request with exactly these headers, as a browser would send it: its status and Set-Cookie headers. */
function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(`${base}${path}`, { method, headers, agent: false }, (response) => {
      response.resume();
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, cookies: response.headers["set-cookie"] ?? [] }),
      );
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

const FORM = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "text/html",
  "Sec-Fetch-Mode": "navigate",
  Cookie: "theme=dark; sessionid=abc; tracepanel_redirect=01EARLIER",
  "X-Api-Key": "k3y",
};

test("a form's POST is recorded with its secrets masked, its redirect named in the cookie for the next page", async () => {
  const body = "email=ann%40example.com&password=hunter2&tags=a&tags=b+c";

  const answer = await send("POST", "/login?next=%2Fhome&token=t0k", FORM, body);

  expect(answer).toEqual({
    status: 303,
    cookies: ["sessionid=s3cr3t; Path=/", "tracepanel_redirect=01EARLIER%2C01TRACE; Max-Age=30; Path=/; SameSite=Lax"],
  });

  expect(recorded).toEqual({
    "http.request.header.content_type": "application/x-www-form-urlencoded",
    "http.request.header.accept": "text/html",
    "http.request.header.sec_fetch_mode": "navigate",
    "http.request.header.x_api_key": "********",
    "http.request.header.host": base.slice("http://".length),
    "http.request.header.connection": "close",
    "http.request.header.content_length": String(body.length),
    "url.query": "next=/home&token=********",
    "http.request.cookie.theme": "dark",
    "http.request.cookie.sessionid": "********",
    "http.request.cookie.tracepanel_redirect": "01EARLIER",
    "http.request.body": "email=ann@example.com&password=********&tags=a&tags=b c",
    "http.response.header.x_powered_by": "Express",
    "http.response.header.set_cookie": "********",
    "http.response.header.location": "/home",
    "http.response.header.content_type": "text/html; charset=utf-8",
    "http.response.header.content_length": expect.any(String),
    "http.response.header.vary": "Accept",
  });
});

test("a JSON body is recorded as the parser read it, the values under secret names masked at any depth", async () => {
  const body = JSON.stringify({ title: "Dune", writer: { name: "Herbert", api_key: "k" }, password: "p" });

  await send("POST", "/api/books", { "Content-Type": "application/json", "Sec-Fetch-Mode": "cors" }, body);

  expect(recorded["http.request.body"]).toBe(
    '{"title":"Dune","writer":{"name":"Herbert","api_key":"********"},"password":"********"}',
  );
});

test("a body no parser read is not recorded, and a call's redirect sets no cookie", async () => {
  await send("POST", "/raw", { "Content-Type": "application/json" }, '{"password":"p"}');

  expect(recorded["http.request.body"]).toBeUndefined();

  expect(recorded["http.request.header.content_type"]).toBe("application/json");

  const call = await send("POST", "/login", { ...FORM, "Sec-Fetch-Mode": "cors" }, "email=a");

  expect(call).toEqual({ status: 303, cookies: ["sessionid=s3cr3t; Path=/"] });
});

test("nothing the request carried is recorded with TRACEPANEL_CAPTURE_REQUEST off; the redirect cookie still goes", async () => {
  recorded = {};
  tracepanel.config.captureRequest = false;
  try {
    const answer = await send("POST", "/login", FORM, "password=p");

    expect(recorded).toEqual({});

    expect(answer.cookies).toEqual([
      "sessionid=s3cr3t; Path=/",
      "tracepanel_redirect=01EARLIER%2C01TRACE; Max-Age=30; Path=/; SameSite=Lax",
    ]);
  } finally {
    tracepanel.config.captureRequest = true;
  }
});
