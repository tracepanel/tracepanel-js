import { readFileSync } from "node:fs";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { wrapFetch } from "../src/fetch.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { checkout, shippingRates } from "./app/shop.js";

// The project is test/app: its code is the app's, this file stands for the libraries.
const APP = new URL("./app/", import.meta.url);
const config: Config = { ...loadConfig({}), enabled: true, root: APP.pathname.slice(0, -1), service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (trace) => sent.push(trace) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** `shop.ts:<line>`: the line of the app with this comment. */
function line(comment: string): string {
  const lines = readFileSync(new URL("shop.ts", APP), "utf8").split("\n");
  return `shop.ts:${lines.findIndex((text) => text.includes(`// ${comment}`)) + 1}`;
}

/** undici's span of a call: started from a timer inside fetch, where none of the app's code is on the stack. */
function undici(url: string): Promise<Response> {
  return new Promise((done) => {
    setTimeout(() => {
      const span = tracer.startSpan("GET", {
        kind: SpanKind.CLIENT,
        attributes: { "http.request.method": "GET", "url.full": url, "http.response.status_code": 200 },
      });
      setTimeout(() => {
        span.end();
        done(new Response("{}"));
      }, 2);
    }, 1);
  });
}

/** Next.js's fetch: its own span, started in the app's call, with undici's call inside it. */
async function nextFetch(url: string): Promise<Response> {
  const span = tracer.startSpan(`fetch GET ${url}`, {
    kind: SpanKind.CLIENT,
    attributes: { "next.span_type": "AppRender.fetch", "http.method": "GET", "http.url": url },
  });
  const response = await context.with(trace.setSpan(context.active(), span), () => undici(url));
  span.end();
  return response;
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

function calls(result: Trace): [string, string][] {
  return result.spans
    .filter((span) => span.kind === "http.client")
    .map((span) => [span.name, String(span.attrs["code.origin"]).split(" in ")[0] ?? ""]);
}

describe("outgoing calls", () => {
  it("records a Next.js fetch once, from where the app called it", async () => {
    const result = await request(() => shippingRates(nextFetch));

    expect(calls(result)).toEqual([
      ["GET 127.0.0.1/ups", line("ups")],
      ["GET 127.0.0.1/dhl", line("dhl")],
    ]);

    const root = result.spans.find((span) => span.kind === "http");
    expect(result.spans.filter((span) => span.kind === "http.client").map((span) => span.parent_id)).toEqual([
      root?.id,
      root?.id,
    ]);
  });

  it("takes a fetch's line from where the app called it, not from the statement before", async () => {
    const result = await request(() => checkout(tracer, wrapFetch(undici, config.root)));

    expect(calls(result)).toEqual([["GET 127.0.0.1/charge", line("charge")]]);
  });
});
