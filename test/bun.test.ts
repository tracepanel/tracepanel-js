// withTracepanel() on a fetch handler (Bun.serve, Hono, Elysia): a page gets the widget's script, put into its body
// as the client reads it; the request's span ends with that body.
import { expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { withTracepanel } from "../src/bun.js";
import { loadConfig } from "../src/config.js";
import type { TracepanelProcessor } from "../src/processor.js";
import type { Runtime } from "../src/runtime.js";
import { badge } from "../src/widget.js";

const KEY = Symbol.for("tracepanel.runtime");
// Started already: the test's handlers are wrapped without hooking the process.
const STARTED = Symbol.for("tracepanel.started");
const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

const processor = {
  timing: () => ({ id: "01TRACE", queries: 0, dbMs: 0, startedMs: performance.now() }),
  framework: () => "Bun.serve",
  setFramework: () => {},
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
