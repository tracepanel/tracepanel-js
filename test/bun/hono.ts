// Run by Bun itself (`bun test/bun/hono.ts`, in CI's Bun job): a Hono app with tracepanel()'s middleware under
// serve()'s withTracepanel(). The middleware names the trace by the route and makes the handler's span; withTracepanel() marks
// the response, once: a page gets one script.
import assert from "node:assert/strict";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { Hono } from "hono";
import type { ConsoleUrl, Starter } from "../../src/agent.js";
import { serve } from "../../src/bun.js";
import { loadConfig } from "../../src/config.js";
import { tracepanel as middleware } from "../../src/hono.js";
import type { Trace } from "../../src/model.js";
import { TracepanelProcessor } from "../../src/processor.js";
import type { Runtime } from "../../src/runtime.js";
import { badge } from "../../src/widget.js";

const traces: Trace[] = [];
const config = { ...loadConfig({}), enabled: true, service: "shop" };
const processor = new TracepanelProcessor(config, { submit: (done) => traces.push(done) });
const tracepanel: Runtime = {
  config,
  processor,
  starter: { ensure: () => false } as unknown as Starter,
  console: { get: () => "http://127.0.0.1:9/" } as unknown as ConsoleUrl,
  badge: (request) => badge(tracepanel, request),
};
// Started already: the handlers are wrapped without hooking the process.
Object.assign(globalThis, { [Symbol.for("tracepanel.runtime")]: tracepanel, [Symbol.for("tracepanel.started")]: true });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));

const app = new Hono();
app.use(middleware());
app.get("/books/:id", (c) => c.html(`<html><head></head><body>${c.req.param("id")}</body></html>`));

const server = serve({ port: 0, fetch: app.fetch }) as { port: number; stop(force?: boolean): void };

async function traceOf(response: Response): Promise<Trace> {
  const id = response.headers.get("tracepanel-id");
  for (let waited = 0; waited < 2000; waited += 10) {
    const found = traces.find((done) => done.id === id);
    if (found) return found;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no trace ${id}`);
}

try {
  const response = await fetch(`http://127.0.0.1:${server.port}/books/7`);
  const page = await response.text();
  const result = await traceOf(response);
  assert.equal(page.match(/<script /g)?.length, 1);
  assert.ok(page.endsWith("</script></head><body>7</body></html>"));
  assert.ok(page.includes('data-tracepanel-runtime="Bun '));
  assert.ok(page.includes(" · Hono 4."));
  assert.deepEqual(
    [result.name, result.attrs["http.route"], result.spans.map((span) => [span.kind, span.name])],
    [
      "GET /books/:id",
      "/books/:id",
      [
        ["view", "/books/:id"],
        ["http", "GET /books/:id"],
      ],
    ],
  );

  // biome-ignore lint/suspicious/noConsole: the script's result, for CI's log
  console.log("Hono on Bun traced");
} finally {
  server.stop(true);
}
