import { type Attributes, context, type Span, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

// The project is this repository: this file is the app's code, the SDK's and OpenTelemetry's are not.
const config: Config = { ...loadConfig({}), enabled: true, root: process.cwd(), service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (trace) => sent.push(trace) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const UNDICI = {
  "http.request.method": "GET",
  "url.full": "http://127.0.0.1:8062/rates",
  "server.address": "127.0.0.1",
  "server.port": 8062,
  "http.response.status_code": 200,
};

/**
 * A span started where the app's code is nowhere on the stack, as undici starts fetch()'s: from a promise job that
 * calls the tracer directly.
 */
function startedLater(name: string, attributes: Attributes): Promise<Span> {
  const start = tracer.startSpan.bind(tracer, name, { kind: SpanKind.CLIENT, attributes }, context.active());
  return Promise.resolve().then(start);
}

async function request(handler: () => Promise<void>): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/shipping" },
  });
  await context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await pause(60);
  return sent.at(-1) as Trace;
}

describe("outgoing calls", () => {
  it("records a Next.js fetch once, from where the app called it", async () => {
    const result = await request(async () => {
      // Next.js's fetch span, started in the app's call; undici's under it, started later.
      const next = tracer.startSpan("fetch GET http://127.0.0.1:8062/rates", {
        kind: SpanKind.CLIENT,
        attributes: {
          "next.span_type": "AppRender.fetch",
          "http.method": "GET",
          "http.url": "http://127.0.0.1:8062/rates",
        },
      });
      await context.with(trace.setSpan(context.active(), next), async () => {
        const undici = await startedLater("GET", UNDICI);
        await pause(2);
        undici.end();
      });
      next.end();
    });

    expect(result.spans.map((span) => [span.kind, span.name])).toEqual([
      ["http.client", "GET 127.0.0.1/rates"],
      ["http", "GET /shipping"],
    ]);

    const call = result.spans[0];
    expect(call?.parent_id).toBe(result.spans[1]?.id);
    expect(call?.attrs["code.origin"]).toMatch(/^test\/calls-in-trace\.test\.ts:\d+ in /);
  });
});
