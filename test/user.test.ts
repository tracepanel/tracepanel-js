import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { setUser } from "../src/api.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (trace) => sent.push(trace) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
// The process's Tracepanel, as register() leaves it.
(globalThis as Record<symbol, unknown>)[Symbol.for("tracepanel.runtime")] = { config, processor };
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

async function request(handler: () => void): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/account/me" },
  });
  context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

describe("setUser", () => {
  it("names the signed-in user on the request's trace", async () => {
    const result = await request(() => setUser({ id: 42, username: "alex@example.com" }));

    expect(result.attrs).toMatchObject({ "user.id": "42", "user.username": "alex@example.com" });
  });

  it("marks a request without a signed-in user", async () => {
    const result = await request(() => setUser(null));

    expect(result.attrs["user.id"]).toBeNull();
    expect(result.attrs).not.toHaveProperty("user.username");
  });

  it("does nothing outside a trace", () => {
    expect(() => setUser({ id: "7" })).not.toThrow();
  });
});
