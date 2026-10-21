// withTracepanel() on a fetch handler (Bun.serve, Hono, Elysia): a page gets the widget's script, put into its body
// as the client reads it; the request's span ends with that body. What the request carried goes into its trace, the
// body as far as the handler read it (Hono's and Elysia's readers too); a page's redirect sets the cookie the next
// page's panel reads.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { withTracepanel } from "../src/bun.js";
import { loadConfig } from "../src/config.js";
import type { Attrs } from "../src/model.js";
import type { TracepanelProcessor } from "../src/processor.js";
import { MAX_BODY } from "../src/request.js";
import type { Runtime } from "../src/runtime.js";
import { badge } from "../src/widget.js";

const KEY = Symbol.for("tracepanel.runtime");
// Started already: the test's handlers are wrapped without hooking the process.
const STARTED = Symbol.for("tracepanel.started");
const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

/** What went into the trace's attributes, by the last request. */
let recorded: Attrs = {};
const processor = {
  timing: () => ({ id: "01TRACE", queries: 0, dbMs: 0, startedMs: performance.now() }),
  framework: () => "Bun.serve",
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
Object.assign(globalThis, { [KEY]: tracepanel, [STARTED]: true });

const SCRIPT = expect.stringMatching(/^<script src="http:\/\/127\.0\.0\.1:9\/widget\.min\.js" [^>]*><\/script>$/);

function pieces(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function read(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const out: string[] = [];
  for await (const piece of body) out.push(decoder.decode(piece));
  return out;
}

test("a streamed page gets the script as its head passes, piece by piece", async () => {
  const handler = withTracepanel(
    (_request: Request) =>
      new Response(pieces("<!doctype html><html><he", "ad><title>t</title></head>", "<body>x</body></html>"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  );

  const response = await handler(new Request("http://localhost/streamed"));
  const [first, second, third] = await read(response.body as ReadableStream<Uint8Array>);

  expect([response.headers.get("tracepanel-id"), response.headers.get("content-length")]).toEqual(["01TRACE", null]);

  expect(first).toBe("<!doctype html><html>");

  expect(second?.split(/(<script .*?<\/script>)/)).toEqual(["<head>", SCRIPT, "<title>t</title></head>"]);
  expect(third).toBe("<body>x</body></html>");
});

test("a page with its size declared gets the script into its whole body", async () => {
  const handler = withTracepanel(
    (_request: Request) =>
      new Response(PAGE, { headers: { "Content-Type": "text/html", "Content-Length": String(PAGE.length) } }),
  );

  const response = await handler(new Request("http://localhost/page"));

  expect([response.headers.get("content-length"), (await response.text()).split(/(<script .*?<\/script>)/)]).toEqual([
    null,
    ["<!doctype html><html><head>", SCRIPT, "<title>t</title></head><body>x</body></html>"],
  ]);
});

test("a compressed page is left as it is, with the badge's headers", async () => {
  const handler = withTracepanel(
    (_request: Request) =>
      new Response(pieces(PAGE), { headers: { "Content-Type": "text/html", "Content-Encoding": "identity" } }),
  );

  const response = await handler(new Request("http://localhost/compressed"));

  expect([response.headers.get("tracepanel-id"), await response.text()]).toEqual(["01TRACE", PAGE]);
});

test("what the request carried is recorded, the body it read too; a page's redirect sets the cookie for the next one", async () => {
  const handler = withTracepanel(async (request: Request) => {
    await request.text();
    return new Response(null, { status: 302, headers: { Location: "/home", "Set-Cookie": "sid=1; Path=/" } });
  });

  const response = await handler(
    new Request("http://localhost/login?page=2&api_key=k", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Mode": "navigate",
        Cookie: "theme=dark; csrftoken=c",
        Authorization: "Bearer t",
      },
      body: "password=p",
    }),
  );

  expect(response.headers.getSetCookie()).toEqual([
    "sid=1; Path=/",
    "tracepanel_redirect=01TRACE; Max-Age=30; Path=/; SameSite=Lax",
  ]);

  expect(recorded).toEqual({
    "http.request.header.authorization": "********",
    "http.request.header.content_type": "application/x-www-form-urlencoded",
    "http.request.header.sec_fetch_mode": "navigate",
    "url.query": "page=2&api_key=********",
    "http.request.cookie.theme": "dark",
    "http.request.cookie.csrftoken": "********",
    "http.request.body": "password=********",
    "http.response.header.location": "/home",
    "http.response.header.set_cookie": "********",
  });
});

test("a call's redirect (fetch, not a page) sets no cookie", async () => {
  const handler = withTracepanel(
    (_request: Request) => new Response(null, { status: 302, headers: { Location: "/home" } }),
  );

  const response = await handler(new Request("http://localhost/go", { headers: { "Sec-Fetch-Mode": "cors" } }));

  expect([response.status, response.headers.getSetCookie()]).toEqual([302, []]);
});

function body(): Attrs {
  return Object.fromEntries(Object.entries(recorded).filter(([name]) => name.startsWith("http.request.body")));
}

function post(path: string, init: RequestInit): Request {
  return new Request(`http://localhost${path}`, { method: "POST", ...init });
}

test("the body as the handler read it: JSON and forms masked, a multipart form's files by name and size", async () => {
  const handler = withTracepanel(async (request: Request) => {
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("application/json")) return new Response(String(((await request.json()) as { a: number }).a));
    const form = await request.formData();
    const cover = form.get("cover");
    return new Response(`${form.get("title")} ${cover instanceof File ? cover.size : "-"}`);
  });

  const json = await handler(
    post("/json", { headers: { "Content-Type": "application/json" }, body: '{"a":1,"secret":"s"}' }),
  );

  expect([await json.text(), body()]).toEqual(["1", { "http.request.body": '{"a":1,"secret":"********"}' }]);

  const form = new FormData();
  form.set("title", "Dune");
  form.set("cover", new File([new Uint8Array(3 * MAX_BODY)], "dune.png"));
  const multipart = await handler(post("/form", { body: form }));

  expect([await multipart.text(), body()]).toEqual([
    `Dune ${3 * MAX_BODY}`,
    { "http.request.body": `title=Dune&cover=<file dune.png, ${3 * MAX_BODY} bytes>` },
  ]);

  const encoded = await handler(post("/form", { body: new URLSearchParams({ title: "Dune", api_key: "k" }) }));

  expect([await encoded.text(), body()]).toEqual(["Dune -", { "http.request.body": "title=Dune&api_key=********" }]);
});

test("a large upload streamed through the handler arrives whole, and the trace keeps its start", async () => {
  const pieces = Array.from({ length: 64 }, (_, at) => new Uint8Array(64 * 1024).fill(97 + (at % 26)));
  const hash = createHash("sha256");
  for (const piece of pieces) hash.update(piece);
  const upload = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces.shift();
      if (piece) controller.enqueue(piece);
      else controller.close();
    },
  });
  const handler = withTracepanel(async (request: Request) => {
    const got = createHash("sha256");
    let size = 0;
    for await (const piece of request.body as ReadableStream<Uint8Array>) {
      size += piece.length;
      got.update(piece);
    }
    return new Response(`${size} ${got.digest("hex")}`);
  });

  const answer = await handler(
    post("/upload", { headers: { "Content-Type": "text/plain" }, body: upload, duplex: "half" } as RequestInit),
  );

  expect([await answer.text(), body()]).toEqual([
    `${64 * 64 * 1024} ${hash.digest("hex")}`,
    { "http.request.body": "a".repeat(MAX_BODY), "http.request.body.truncated": true },
  ]);
});

test("a body the handler never reads is not recorded, nor waited for; the request stays the server's own", async () => {
  const request = post("/books/7", { headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
  // Bun's routes put the route's parameters on the request itself.
  Object.assign(request, { params: { id: "7" } });
  const handler = withTracepanel(
    (got: Request) => new Response(`${got === request} ${(got as Request & { params: { id: string } }).params.id}`),
  );

  const answer = await handler(request);

  expect([await answer.text(), body()]).toEqual(["true 7", {}]);
});

test("a clone the handler reads is its own, the body read once more as it was", async () => {
  const handler = withTracepanel(async (request: Request) => {
    const copy = await request.clone().text();
    return new Response(`${copy} ${await request.text()}`);
  });

  const answer = await handler(post("/twice", { headers: { "Content-Type": "text/plain" }, body: "hi" }));

  expect([await answer.text(), body()]).toEqual(["hi hi", { "http.request.body": "hi" }]);
});

test("a body read twice fails as the request's own would", async () => {
  const handler = withTracepanel(async (request: Request) => {
    await request.text();
    const again = await request.text().then(
      () => "read",
      (error: unknown) => (error instanceof TypeError ? "TypeError" : String(error)),
    );
    return new Response(again);
  });

  const answer = await handler(post("/again", { headers: { "Content-Type": "text/plain" }, body: "hi" }));

  expect(await answer.text()).toBe("TypeError");
});

test("Hono through withTracepanel: its validators' readers read through the tap", async () => {
  const app = new Hono();
  app.post("/books", async (c) => c.text(`added ${((await c.req.json()) as { title: string }).title}`));
  app.post("/login", async (c) => c.text(`hello ${(await c.req.parseBody()).email}`));
  const handler = withTracepanel(app.fetch);

  const json = await handler(
    post("/books", { headers: { "Content-Type": "application/json" }, body: '{"title":"Dune","token":"t"}' }),
  );

  expect([await json.text(), body()]).toEqual([
    "added Dune",
    { "http.request.body": '{"title":"Dune","token":"********"}' },
  ]);

  const form = await handler(post("/login", { body: new URLSearchParams({ email: "a@b.c", password: "p" }) }));

  expect([await form.text(), body()]).toEqual([
    "hello a@b.c",
    { "http.request.body": "email=a@b.c&password=********" },
  ]);
});

test("TRACEPANEL_CAPTURE_REQUEST=0 leaves the request as it came", async () => {
  tracepanel.config.captureRequest = false;
  recorded = {};
  const request = post("/off", { headers: { "Content-Type": "text/plain" }, body: "hi" });
  const handler = withTracepanel(async (got: Request) => new Response(await got.text()));

  const answer = await handler(request);

  expect([await answer.text(), Object.hasOwn(request, "text"), recorded]).toEqual(["hi", false, {}]);

  tracepanel.config.captureRequest = true;
});
