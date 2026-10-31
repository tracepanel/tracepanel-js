// A trace's profile: where its time went in code, sampled while it runs, when the request asks or the setting says.
// A sample taken while another trace runs too can't be told apart: it is left out, and counted.

import inspector, { type Session } from "node:inspector";
import { fileURLToPath } from "node:url";
import { context, type Span as OtelSpan, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { hello } from "../src/agent.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { ASKED, asks, REASON, requested } from "../src/profile.js";
import { catalog, crunchOrders, crunchPrices, crunchRates, crunchStock, crunchTaxes, loadCatalog } from "./app/shop.js";

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

/**
 * Busy until the profiler has sampled the thread: a fixed time is no promise of a sample, as a busy machine can run
 * the profiler's sampling thread too seldom (a trace with no sample sends no profile). A console profile of its own,
 * taken by the trace's profiler while the trace runs: any sample in it is in the trace's too.
 */
function busyUntilSampled(processor: TracepanelProcessor): void {
  const session = (processor as unknown as { profiler: { session: Session } }).profiler.session;
  for (let probe = 0; ; probe++) {
    const title = `test:sampled:${probe}`;
    let sampled = false;
    const finished = (message: { params: { title?: string; profile: inspector.Profiler.Profile } }) => {
      if (message.params.title !== title) return;
      const { nodes, samples = [] } = message.params.profile;
      const idle = new Set(nodes.filter((node) => node.callFrame.functionName === "(idle)").map((node) => node.id));
      sampled = samples.some((id) => !idle.has(id));
    };
    session.on("Profiler.consoleProfileFinished", finished);
    inspector.console.profile(title);
    busy(5);
    inspector.console.profileEnd(title);
    session.off("Profiler.consoleProfileFinished", finished);
    if (sampled) return;
  }
}

/** The whole heap collected: V8 does it in a task of its own, done when the inspector answers. */
async function collectGarbage(): Promise<void> {
  const session = new inspector.Session();
  session.connect();
  await new Promise((done, failed) =>
    session.post("HeapProfiler.collectGarbage", (error) => (error ? failed(error) : done(undefined))),
  );
  session.disconnect();
}

/** A processor of its own, with these settings, and the traces it sends. */
function app(env: Record<string, string> = {}) {
  const config: Config = { ...loadConfig(env), enabled: true, root, service: "shop" };
  const sent: Trace[] = [];
  const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
  const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("test");

  /**
   * A request's root span; `profile`: what it asks to be profiled for, `reason`: how, as Node's HTTP server marks one
   * (the app's own code marks none).
   */
  function start(path: string, profile: boolean | "1" | "memory" = false, reason?: string): OtelSpan {
    return tracer.startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "GET",
        "url.path": path,
        ...(profile ? { "tracepanel.profile": profile } : {}),
        ...(reason ? { "tracepanel.profile.reason": reason } : {}),
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

  return { start, end, tracer, processor };
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
      gc: { collections: expect.any(Number), pause_us: expect.any(Number), pauses: expect.any(Array) },
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

  it("says why the trace is profiled in profile.reason: the setting when it profiles every trace, else the first ask", async () => {
    const { start, end } = app();
    const fromHeader = start("/header", "1", "header");
    busy(5);
    const header = await end(fromHeader, "/header");
    const fromCookie = start("/cookie", "memory", "cookie");
    busy(5);
    const cookie = await end(fromCookie, "/cookie");
    const fromParent = start("/parent", "1", "parent");
    busy(5);
    const parent = await end(fromParent, "/parent");
    const byCode = start("/code", true);
    busy(5);
    const code = await end(byCode, "/code");
    const inNext = context.with(context.active().setValue(ASKED, "1").setValue(REASON, "cookie"), () => start("/next"));
    busy(5);
    const next = await end(inNext, "/next");
    // The app's code marked the root span, in a context whose request asked with its header: the code asked first.
    const codeFirst = context.with(context.active().setValue(ASKED, "1").setValue(REASON, "header"), () =>
      start("/code-first", true),
    );
    busy(5);
    const codeThenHeader = await end(codeFirst, "/code-first");
    const plain = start("/plain");
    busy(5);
    const unprofiled = await end(plain, "/plain");

    expect(
      [header, cookie, parent, code, next, codeThenHeader, unprofiled].map((done) => done.attrs["profile.reason"]),
    ).toEqual(["header", "cookie", "parent", "code", "cookie", "code", undefined]);

    const always = app({ TRACEPANEL_PROFILE: "1" });
    const every = always.start("/every");
    busy(5);
    const asked = always.start("/asked", "1", "header");
    busy(5);

    expect([
      (await always.end(every, "/every")).attrs["profile.reason"],
      (await always.end(asked, "/asked")).attrs["profile.reason"],
    ]).toEqual(["setting", "setting"]);
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

/** The memory's sites by the app's function that allocated, innermost first: its bytes and samples. */
function sites(result: Trace): Record<string, { bytes: number; count: number }> {
  const found: Record<string, { bytes: number; count: number }> = {};
  for (const site of result.profile?.memory?.sites ?? []) {
    const own = site.frames.map((index) => result.profile?.frames[index]).filter((frame) => frame?.in_app);
    const name = own.at(-1)?.function ?? "(library)";
    const known = found[name] ?? { bytes: 0, count: 0 };
    found[name] = { bytes: known.bytes + site.bytes, count: known.count + site.count };
  }
  return found;
}

describe("a trace's memory", () => {
  it("is profiled when the request asks for memory: the heap's peak and net, and where it was kept", async () => {
    const { start, end } = app();
    // The garbage of the tests before, collected first: the peak is measured from the heap's level at the start, and a
    // collection of that garbage while the trace runs would take the catalog's bytes off it.
    await collectGarbage();
    const span = start("/catalog", "memory");
    loadCatalog(50_000);
    const result = await end(span, "/catalog");

    expect(result.profile?.memory).toEqual({
      peak: expect.any(Number),
      net: expect.any(Number),
      ...(process.versions.node.split(".")[0] === "26" ? { allocated: expect.any(Number) } : {}),
      sites: expect.any(Array),
      sites_at: "end",
      shared: false,
    });
    // 50,000 products of about 100 bytes each, and the catalog's array: megabytes, each a sample in 32 KB.
    expect(result.profile?.memory?.peak).toBeGreaterThan(2_000_000);
    expect(sites(result).loadCatalog).toEqual({ bytes: expect.any(Number), count: expect.any(Number) });
    expect(sites(result).loadCatalog?.bytes).toBeGreaterThan(2_000_000);
    expect(result.profile?.frames).toContainEqual({
      function: "loadCatalog",
      module: null,
      file: "shop.ts",
      line: expect.any(Number),
      in_app: true,
    });
    // No site of this package's own.
    const own = (result.profile?.memory?.sites ?? []).filter((site) =>
      site.frames.some((index) => result.profile?.frames[index]?.file.startsWith(OWN)),
    );
    expect(own).toEqual([]);
    catalog.length = 0;
  });

  it("is profiled for every profiled trace with TRACEPANEL_PROFILE_MEMORY=1; not for one that asks for the time", async () => {
    const timeOnly = app();
    const asked = timeOnly.start("/time", "1");
    loadCatalog(1000);
    // A profile with no sample isn't sent.
    busyUntilSampled(timeOnly.processor);
    const time = await timeOnly.end(asked, "/time");

    expect(time.profile?.memory).toBeUndefined();
    expect(time.profile?.gc).toEqual({
      collections: expect.any(Number),
      pause_us: expect.any(Number),
      pauses: expect.any(Array),
    });

    const every = app({ TRACEPANEL_PROFILE_MEMORY: "1" });
    const timed = every.start("/every", "1");
    loadCatalog(20_000);
    const result = await every.end(timed, "/every");

    expect(sites(result).loadCatalog?.bytes).toBeGreaterThan(500_000);
    catalog.length = 0;
  });

  it("says when another trace ran meanwhile: the heap is the process's", async () => {
    const { start, end } = app();
    const profiled = start("/first", "memory");
    const other = start("/other");
    loadCatalog(1000);
    other.end();
    const result = await end(profiled, "/first");

    expect(result.profile?.memory?.shared).toBe(true);
    catalog.length = 0;
  });

  it("has each collection's pause on the trace's clock", async () => {
    const { start, end } = app();
    const span = start("/garbage", "1");
    // Young objects, thrown away at once: the young generation is collected, several times over.
    let trash: { at: number }[] = [];
    for (let at = 0; at < 2_000_000; at++) {
      trash.push({ at });
      if (trash.length === 1000) trash = [];
    }
    const result = await end(span, "/garbage");

    const gc = result.profile?.gc;
    expect(gc?.collections).toBeGreaterThan(0);
    expect(gc?.pauses).toHaveLength(gc?.collections ?? 0);
    expect(gc?.pause_us).toBe(gc?.pauses.reduce((sum, [, length]) => sum + length, 0));
    for (const [from, , generation] of gc?.pauses ?? []) {
      expect(from).toBeLessThanOrEqual(result.duration);
      expect([0, 1, 2]).toContain(generation);
    }
  });
});

describe("asking for a profile", () => {
  it("is the X-Tracepanel-Profile header or the panel's cookie", () => {
    expect([
      requested({ "x-tracepanel-profile": "1" }),
      requested({ "x-tracepanel-profile": " 1 " }),
      requested({ cookie: "a=b; tracepanel_profile=1" }),
      requested({ "x-tracepanel-profile": "memory" }),
      requested({ cookie: "tracepanel_profile=memory" }),
      requested({ "x-tracepanel-profile": "0" }),
      requested({ cookie: "tracepanel_profile=0; my_tracepanel_profile=1" }),
      requested({ cookie: "tracepanel_profile=all" }),
      requested({}),
    ]).toEqual(["1", "1", "1", "memory", "memory", undefined, undefined, undefined, undefined]);
  });

  it("says how the request asked: the header, the header with a traceparent (another app's call), the cookie", () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    expect([
      asks({ "x-tracepanel-profile": "1" }),
      asks({ "x-tracepanel-profile": "memory", traceparent }),
      asks({ cookie: "tracepanel_profile=1", traceparent }),
      asks({ cookie: "tracepanel_profile=0" }),
      asks({}),
    ]).toEqual([
      { asked: "1", reason: "header" },
      { asked: "memory", reason: "parent" },
      { asked: "1", reason: "cookie" },
      undefined,
      undefined,
    ]);
  });

  it("is offered in the hello while profiling is on, every trace's when TRACEPANEL_PROFILE=1", () => {
    expect(hello(loadConfig({})).capabilities).toEqual(["explain", "request", "profile", "profile_memory"]);

    expect(hello(loadConfig({ TRACEPANEL_PROFILE_ENABLED: "0" })).capabilities).toEqual(["explain", "request"]);

    expect(hello(loadConfig({ TRACEPANEL_PROFILE: "1" })).capabilities).toEqual([
      "explain",
      "request",
      "profile",
      "profile_all",
      "profile_memory",
    ]);

    expect(hello(loadConfig({ TRACEPANEL_PROFILE_MEMORY: "1" })).capabilities).toEqual([
      "explain",
      "request",
      "profile",
      "profile_memory",
      "profile_memory_all",
    ]);

    expect(hello(loadConfig({ TRACEPANEL_PROFILE_MEMORY: "1", TRACEPANEL_PROFILE_ENABLED: "0" })).capabilities).toEqual(
      ["explain", "request"],
    );

    expect(hello(loadConfig({ TRACEPANEL_PROFILE: "1", TRACEPANEL_PROFILE_ENABLED: "0" })).capabilities).toEqual([
      "explain",
      "request",
    ]);

    expect([
      loadConfig({}).profile,
      loadConfig({ TRACEPANEL_PROFILE: "1" }).profile,
      loadConfig({}).profileIntervalMs,
      loadConfig({ TRACEPANEL_PROFILE_INTERVAL_MS: "5" }).profileIntervalMs,
      loadConfig({ TRACEPANEL_PROFILE_INTERVAL_MS: "0" }).profileIntervalMs,
      loadConfig({}).profileMemory,
      loadConfig({ TRACEPANEL_PROFILE_MEMORY: "1" }).profileMemory,
    ]).toEqual([false, true, 1, 5, 1, false, true]);
  });
});
