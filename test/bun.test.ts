// withTracepanel() on a fetch handler (Bun.serve, Hono, Elysia): a page gets the widget's script, put into its body
// as the client reads it; the request's span ends with that body. What the request carried goes into its trace, but
// not its body, which the handler reads itself; a page's redirect sets the cookie the next page's panel reads.
import { expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { withTracepanel } from "../src/bun.js";
import { loadConfig } from "../src/config.js";
import type { Attrs } from "../src/model.js";
import type { TracepanelProcessor } from "../src/processor.js";
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

test("what the request carried is recorded, its body not; a page's redirect sets the cookie for the next one", async () => {
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
