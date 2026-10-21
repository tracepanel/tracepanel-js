// BullMQ on a real Redis, its task events to a real agent: the console's `api/tasks/live` lists a job queued, then
// running in its worker, and neither once they finished. It runs when TRACEPANEL_TEST_REDIS names a Redis
// (redis://127.0.0.1:6379), with the agent from @tracepanel/agent, or TRACEPANEL_AGENT_BIN's.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { Sender, Starter } from "../src/agent.js";
import { BullMQInstrumentation } from "../src/bullmq.js";
import { loadConfig } from "../src/config.js";
import { TracepanelProcessor } from "../src/processor.js";

const REDIS = process.env.TRACEPANEL_TEST_REDIS;

const store = mkdtempSync(join(tmpdir(), "tracepanel-bullmq-live-"));
let agent: ChildProcess | undefined;
const after: (() => Promise<unknown>)[] = [];

function read(name: string): string {
  try {
    return readFileSync(join(store, name), "utf8").trim();
  } catch {
    return "";
  }
}

async function live(): Promise<{ tasks: Record<string, unknown>[]; workers: Record<string, unknown>[] }> {
  return (await fetch(`${read("console.addr")}api/tasks/live`)).json();
}

beforeAll(async () => {
  if (!REDIS) return;
  const binary =
    process.env.TRACEPANEL_AGENT_BIN ||
    (createRequire(import.meta.url)("@tracepanel/agent") as { binaryPath(): string }).binaryPath();
  agent = spawn(binary, ["--dir", store, "--serve", "127.0.0.1:0"], { stdio: "ignore" });
  await vi.waitFor(() => expect(read("console.addr")).not.toBe(""), { timeout: 10_000 });
  delete process.env.TRACEPANEL_AGENT;
});

afterAll(async () => {
  try {
    for (const close of after.splice(0).reverse()) await close();
  } finally {
    agent?.kill();
    rmSync(store, { recursive: true, force: true });
  }
});

test.skipIf(!REDIS)(
  "a job in flight is listed by the agent: queued, running in its worker, gone once finished",
  async () => {
    const config = { ...loadConfig({ TRACEPANEL_ROOT: store, TRACEPANEL_DIR: store }), service: "shop" };
    const processor = new TracepanelProcessor(config, new Sender(config, new Starter(store)));
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
    const name = `tracepanel-live-${process.pid}`;
    const queue = new bullmq.Queue(name, { connection });
    after.push(() => queue.close());
    after.push(() => queue.obliterate({ force: true }));
    let release: () => void = () => {};
    const released = new Promise<void>((done) => (release = done));
    const worker = new bullmq.Worker(name, () => released, { connection, name: "mailer", concurrency: 1 });
    after.push(() => worker.close());
    // A worker closes once its jobs are done: a failed check lets them go first.
    after.push(async () => release());
    await worker.waitUntilReady();

    // The first job added in a request, the second while the worker runs the first.
    const root = provider.getTracer("test").startSpan("POST", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "POST", "url.path": "/signup" },
    });
    const first = await context.with(trace.setSpan(context.active(), root), () =>
      queue.add("welcome", { to: "ann", password: "hunter2" }),
    );
    root.end();
    await vi.waitFor(async () => expect((await live()).tasks).toMatchObject([{ state: "running" }]), {
      timeout: 10_000,
    });
    const second = await queue.add("digest", 7);
    const inFlight = await vi.waitFor(
      async () => {
        const now = await live();
        expect(now.tasks).toHaveLength(2);
        return now;
      },
      { timeout: 10_000 },
    );

    expect(inFlight.tasks).toEqual([
      {
        id: `${name}:${second.id}`,
        system: "bullmq",
        name: "digest",
        service: "shop",
        state: "queued",
        queue: name,
        worker: null,
        enqueued_at: expect.any(Number),
        started_at: null,
        retries: 0,
        args: "7",
        kwargs: null,
        error: null,
        enqueued_by: null,
      },
      {
        id: `${name}:${first.id}`,
        system: "bullmq",
        name: "welcome",
        service: "shop",
        state: "running",
        queue: name,
        worker: "mailer",
        enqueued_at: expect.any(Number),
        started_at: expect.any(Number),
        retries: 0,
        args: '{"to":"ann","password":"********"}',
        kwargs: null,
        error: null,
        enqueued_by: { trace_id: expect.any(String), span_id: expect.any(String) },
      },
    ]);

    expect(inFlight.workers).toEqual([
      { name: "mailer", system: "bullmq", service: "shop", last_seen: expect.any(Number), in_flight: 1 },
    ]);

    expect(await (await fetch(`${read("console.addr")}api/capabilities`)).json()).toMatchObject({ live_tasks: true });

    release();
    await vi.waitFor(async () => expect((await live()).tasks).toEqual([]), { timeout: 10_000 });

    expect((await live()).workers).toEqual([
      { name: "mailer", system: "bullmq", service: "shop", last_seen: expect.any(Number), in_flight: 0 },
    ]);
  },
);
