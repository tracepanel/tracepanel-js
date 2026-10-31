// BullMQ on a real Redis: a job added in a profiled request keeps its `tracepanel-profile` option through Redis, and
// the worker profiles the job's trace, its profile.reason "parent"; a job of a request that didn't ask is not
// profiled. It runs when TRACEPANEL_TEST_REDIS names a Redis (redis://127.0.0.1:6379).
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, expect, test, vi } from "vitest";
import { BullMQInstrumentation } from "../src/bullmq.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const REDIS = process.env.TRACEPANEL_TEST_REDIS;

const after: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const close of after.splice(0).reverse()) await close();
});

test.skipIf(!REDIS)(
  "a job added in a profiled request is profiled by a real worker, its reason the parent's",
  async () => {
    const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
    const sent: Trace[] = [];
    const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    trace.setGlobalTracerProvider(provider);
    after.push(async () => manager.disable());
    const bullmq = await import("bullmq");
    const [definition] = new BullMQInstrumentation(processor).getModuleDefinitions();
    definition?.patch?.(bullmq, "6");

    const url = new URL(REDIS as string);
    const connection = { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
    const name = `tracepanel-profile-live-${process.pid}`;
    const queue = new bullmq.Queue(name, { connection });
    after.push(() => queue.close());
    after.push(() => queue.obliterate({ force: true }));
    // What each job's options were as the worker read them back from Redis.
    const read: Record<string, unknown> = {};
    const worker = new bullmq.Worker(
      name,
      async (job) => {
        read[job.name] = job.opts["tracepanel-profile" as keyof typeof job.opts];
        const until = performance.now() + 20;
        while (performance.now() < until);
      },
      { connection, concurrency: 1 },
    );
    after.push(() => worker.close());
    await worker.waitUntilReady();

    /** A request that adds a job; `asked`: what it asked to be profiled for, by its X-Tracepanel-Profile header. */
    async function request(job: string, asked?: string): Promise<void> {
      const root = provider.getTracer("test").startSpan("POST", {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": "POST",
          "url.path": `/${job}`,
          ...(asked ? { "tracepanel.profile": asked, "tracepanel.profile.reason": "header" } : {}),
        },
      });
      await context.with(trace.setSpan(context.active(), root), () => queue.add(job, { order: 7 }));
      root.end();
    }
    await request("receipt", "memory");
    await request("invoice");

    const tasks = await vi.waitFor(
      () => {
        const found = ["receipt", "invoice"].map((job) =>
          sent.find((done) => done.kind === "task" && done.name === job),
        );
        expect(found).not.toContain(undefined);
        return found as Trace[];
      },
      { timeout: 10_000 },
    );
    const [profiled, plain] = tasks as [Trace, Trace];

    expect(read).toEqual({ receipt: "memory", invoice: undefined });

    expect(profiled.attrs["profile.reason"]).toBe("parent");
    expect(profiled.profile).toEqual(expect.objectContaining({ samples: expect.any(Number) }));

    expect(plain.attrs["profile.reason"]).toBeUndefined();
    expect(plain.profile).toBeUndefined();
  },
);
