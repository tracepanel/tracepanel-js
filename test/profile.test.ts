// A trace's profile: where its time went in code, sampled while it runs, when the request asks or the setting says.
// A sample taken while another trace runs too can't be told apart: it is left out, and counted.

import { fileURLToPath } from "node:url";
import { context, type Span as OtelSpan, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { hello } from "../src/agent.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { ASKED, requested } from "../src/profile.js";
import { crunchOrders, crunchPrices, crunchRates, crunchStock, crunchTaxes } from "./app/shop.js";

// The project is test/app: its code is the app's, this file stands for the framework.
const root = new URL("./app/", import.meta.url).pathname.slice(0, -1);
const OWN = fileURLToPath(new URL("../src/", import.meta.url));
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);

afterAll(() => manager.disable());

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The framework's own work, outside the app. */
function busy(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

/** A processor of its own, with these settings, and the traces it sends. */
function app(env: Record<string, string> = {}) {
  const config: Config = { ...loadConfig(env), enabled: true, root, service: "shop" };
  const sent: Trace[] = [];
  const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
  const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("test");

  /** A request's root span; `profile`: it asks to be profiled, as Node's HTTP server marks one. */
  function start(path: string, profile = false): OtelSpan {
    return tracer.startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "GET",
        "url.path": path,
        ...(profile ? { "tracepanel.profile": true } : {}),
      },
    });
  }

  /** The trace of a request that ended now, as it is sent. */
  async function end(span: OtelSpan, path: string): Promise<Trace> {
    span.setAttribute("http.response.status_code", 200);
    span.end();
    await pause(60);
    return sent.find((done) => done.attrs["http.path"] === path) as Trace;
  }

  return { start, end, tracer };
}

/** The app's functions in the profile's stacks, with the samples that saw each. */
function sampled(result: Trace): Record<string, number> {
  const found: Record<string, number> = {};
  for (const stack of result.profile?.stacks ?? []) {
    for (const index of new Set(stack.frames)) {
      const frame = result.profile?.frames[index];
      if (frame?.in_app) found[frame.function] = (found[frame.function] ?? 0) + stack.count;
    }
  }
  return found;
}

describe("a trace's profile", () => {
  it("is taken when the request asks: the app's functions, by their file and line, as the schema has it", async () => {
    const { start, end } = app();
    const span = start("/prices", true);
    context.with(trace.setSpan(context.active(), span), () => crunchPrices(50));
    const result = await end(span, "/prices");

    expect(result.profile).toEqual({
      interval_us: 1000,
      samples: expect.any(Number),
      frames: expect.any(Array),
      stacks: expect.any(Array),
    });
    expect(result.profile?.frames).toContainEqual({
      function: "crunchPrices",
      module: null,
      file: "shop.ts",
      line: expect.any(Number),
      in_app: true,
    });
    expect(sampled(result).crunchPrices).toBeGreaterThan(0);

    const total = result.profile?.stacks.reduce((sum, stack) => sum + stack.count, 0);
    expect(total).toBe(result.profile?.samples);
    expect(result.attrs["tracepanel.dropped_samples"]).toBeUndefined();
    // No frame of this package's own, and none of an idle loop.
    expect(result.profile?.frames.filter((frame) => frame.function === "(idle)" || frame.file.startsWith(OWN))).toEqual(
      [],
    );
  });

  it("is taken when the framework's context says the request asked (Next.js)", async () => {
    const { start, end } = app();
    const span = context.with(context.active().setValue(ASKED, true), () => start("/next"));
    context.with(trace.setSpan(context.active(), span), () => crunchTaxes(50));
    const result = await end(span, "/next");

    expect(sampled(result).crunchTaxes).toBeGreaterThan(0);
  });

  it("is not taken unless asked; TRACEPANEL_PROFILE=1 profiles every trace, TRACEPANEL_PROFILE_ENABLED=0 none", async () => {
    const unasked = app();
    const plain = unasked.start("/plain");
    busy(10);
    const never = app({ TRACEPANEL_PROFILE_ENABLED: "0" });
    const off = never.start("/off", true);
    busy(10);

    expect((await unasked.end(plain, "/plain")).profile).toBeUndefined();
    expect((await never.end(off, "/off")).profile).toBeUndefined();

    const always = app({ TRACEPANEL_PROFILE: "1" });
    const every = always.start("/every");
    crunchRates(50);
    expect(sampled(await always.end(every, "/every")).crunchRates).toBeGreaterThan(0);
  });

  it("leaves out what was sampled while another trace ran too, and counts it", async () => {
    const { start, end } = app();
    const profiled = start("/first", true);
    crunchOrders(50);
    const other = start("/other");
    crunchStock(50);
    other.end();
    const result = await end(profiled, "/first");

    expect(sampled(result).crunchOrders).toBeGreaterThan(0);
    expect(sampled(result).crunchStock ?? 0).toBeLessThanOrEqual(1);
    expect(result.attrs["tracepanel.dropped_samples"]).toBeGreaterThan(0);
  });
});

describe("asking for a profile", () => {
  it("is the X-Tracepanel-Profile header or the panel's cookie", () => {
    expect([
      requested({ "x-tracepanel-profile": "1" }),
      requested({ "x-tracepanel-profile": " 1 " }),
      requested({ cookie: "a=b; tracepanel_profile=1" }),
      requested({ "x-tracepanel-profile": "0" }),
      requested({ cookie: "tracepanel_profile=0; my_tracepanel_profile=1" }),
      requested({}),
    ]).toEqual([true, true, true, false, false, false]);
  });

  it("is offered in the hello while profiling is on", () => {
    expect(hello(loadConfig({})).capabilities).toEqual(["explain", "request", "profile"]);

    expect(hello(loadConfig({ TRACEPANEL_PROFILE_ENABLED: "0" })).capabilities).toEqual(["explain", "request"]);

    expect([
      loadConfig({}).profile,
      loadConfig({ TRACEPANEL_PROFILE: "1" }).profile,
      loadConfig({}).profileIntervalMs,
      loadConfig({ TRACEPANEL_PROFILE_INTERVAL_MS: "5" }).profileIntervalMs,
      loadConfig({ TRACEPANEL_PROFILE_INTERVAL_MS: "0" }).profileIntervalMs,
    ]).toEqual([false, true, 1, 5, 1]);
  });
});
