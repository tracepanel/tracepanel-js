// Next.js reads a request's body from Node's stream for the app: an App Router route handler's Request, a server
// action's form, a Pages Router API route's raw body. Each piece passes the tap on its way, and the body goes into the
// trace as the response goes out, as far as the app read it; the app gets every byte, an upload still streams.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeEach, expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { tapOf } from "../src/body.js";
import { loadConfig } from "../src/config.js";
import { headersOnResponses } from "../src/headers.js";
import type { Attrs } from "../src/model.js";
import type { TracepanelProcessor } from "../src/processor.js";
import { MAX_BODY } from "../src/request.js";
import type { Runtime } from "../src/runtime.js";

/** What went into the trace's attributes, by the request's path. */
const recorded = new Map<string, Attrs>();
const processor = {
  framework: () => "Next.js",
  setTraceAttrs: (attrs: Attrs, request: { url: string }) => recorded.set(request.url, attrs),
} as unknown as TracepanelProcessor;
const tracepanel: Runtime = {
  config: { ...loadConfig({}), enabled: true },
  processor,
  starter: {} as Starter,
  console: {} as ConsoleUrl,
  badge: () => undefined,
};
headersOnResponses(tracepanel, "Next.js");

/** The body of an App Router request as NodeNextRequest.stream() makes it: the stream's pieces as they come. */
function nextStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      req.on("end", () => controller.close());
    },
  });
}

/** The NextRequest a route handler gets. */
function nextRequest(req: IncomingMessage): Request {
  const headers = new Headers(req.headers as Record<string, string>);
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers,
    body: nextStream(req),
    duplex: "half",
  } as RequestInit);
}

/** The body a middleware read too: Next.js copies its stream onto the request, then reads it again for the route. */
async function middlewareRead(req: IncomingMessage): Promise<void> {
  const copy = new Readable({ read() {} });
  const seen = new PassThrough();
  req.on("data", (chunk) => {
    seen.push(chunk);
    copy.push(chunk);
  });
  await new Promise((resolve) => req.on("end", resolve));
  copy.push(null);
  for (const key in copy) {
    const value = (copy as unknown as Record<string, unknown>)[key];
    (req as unknown as Record<string, unknown>)[key] = typeof value === "function" ? value.bind(req) : value;
  }
}

/** Every byte of the stream, counted and hashed as it passes: an upload the app streams somewhere. */
async function streamed(req: IncomingMessage): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    req,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        hash.update(chunk);
        done();
      },
    }),
  );
  return `${size} ${hash.digest("hex")}`;
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  // app/api/books/route.ts: `await request.json()`.
  "/api/books": async (req, res) => {
    const book = (await nextRequest(req).json()) as { title: string };
    res.end(`added ${book.title}`);
  },
  // A server action posted by a form: its fields, an upload's file with them.
  "/books/new": async (req, res) => {
    const form = await nextRequest(req).formData();
    const cover = form.get("cover");
    res.end(`${form.get("title")} ${cover instanceof File ? `${cover.name} ${cover.size}` : "-"}`);
  },
  // pages/api/login.ts: the body parser reads the stream to its end.
  "/api/login": async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    res.end(`hello ${new URLSearchParams(text).get("email")}`);
  },
  "/api/after-middleware": async (req, res) => {
    await middlewareRead(req);
    let text = "";
    for await (const chunk of req) text += chunk;
    res.end(text);
  },
  "/api/upload": async (req, res) => {
    res.end(await streamed(req));
  },
  "/api/ignored": async (_req, res) => {
    res.end("not read");
  },
};
const app: Server = createServer((req, res) => {
  void routes[req.url ?? "/"]?.(req, res);
});
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

beforeEach(() => {
  recorded.clear();
  tracepanel.config.captureRequest = true;
});

afterAll(() => {
  app.close();
});

function body(path: string): Attrs {
  return Object.fromEntries(
    Object.entries(recorded.get(path) ?? {}).filter(([name]) => name.startsWith("http.request.body")),
  );
}

test("a route handler's JSON body, as it read it, secrets masked", async () => {
  const answer = await fetch(`${base}/api/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Dune", api_key: "k" }),
  });

  expect(await answer.text()).toBe("added Dune");

  expect(body("/api/books")).toEqual({ "http.request.body": '{"title":"Dune","api_key":"********"}' });
});

test("a server action's form: URL-encoded, or multipart with its file by name and size", async () => {
  const form = new FormData();
  form.set("title", "Dune");
  form.set("password", "p");
  form.set("cover", new File([new Uint8Array(40_000)], "dune.png", { type: "image/png" }));

  const multipart = await fetch(`${base}/books/new`, { method: "POST", body: form });

  expect(await multipart.text()).toBe("Dune dune.png 40000");

  expect(body("/books/new")).toEqual({
    "http.request.body": "title=Dune&password=********&cover=<file dune.png, 40000 bytes>",
  });

  const encoded = await fetch(`${base}/books/new`, {
    method: "POST",
    body: new URLSearchParams({ title: "Dune", csrf_token: "t" }),
  });

  expect(await encoded.text()).toBe("Dune -");

  expect(body("/books/new")).toEqual({ "http.request.body": "title=Dune&csrf_token=********" });
});

test("a Pages Router API route's body, read by iterating the stream", async () => {
  const answer = await fetch(`${base}/api/login`, {
    method: "POST",
    body: new URLSearchParams({ email: "a@b.c", password: "p" }),
  });

  expect(await answer.text()).toBe("hello a@b.c");

  expect(body("/api/login")).toEqual({ "http.request.body": "email=a@b.c&password=********" });
});

test("a body a middleware read first, then the route, is recorded once", async () => {
  const answer = await fetch(`${base}/api/after-middleware`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "once",
  });

  expect(await answer.text()).toBe("once");

  expect(body("/api/after-middleware")).toEqual({ "http.request.body": "once" });
});

test("a large upload streams through whole, and the trace keeps its start", async () => {
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

test("a body the app never reads is not recorded, nor waited for", async () => {
  const answer = await fetch(`${base}/api/ignored`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"a":1}',
  });

  expect(await answer.text()).toBe("not read");

  expect([recorded.has("/api/ignored"), body("/api/ignored")]).toEqual([true, {}]);
});

test("TRACEPANEL_CAPTURE_REQUEST=0: no tap, no body", async () => {
  tracepanel.config.captureRequest = false;
  let tapped: unknown = "unset";
  routes["/api/plain"] = async (req, res) => {
    tapped = tapOf(req);
    res.end(await streamed(req));
  };

  const answer = await fetch(`${base}/api/plain`, { method: "POST", body: "x" });

  expect([await answer.text(), tapped, recorded.has("/api/plain")]).toEqual([
    `1 ${createHash("sha256").update("x").digest("hex")}`,
    undefined,
    false,
  ]);
});
