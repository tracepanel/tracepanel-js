// BullMQ's jobs while they are in flight: the task events the console's Live list is made of, in the order a job goes
// through them, beside the traces the job and the request that added it make.
import { createServer, type Socket } from "node:net";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hello, Sender, Starter, sends, type TaskEvent } from "../src/agent.js";
import { BullMQInstrumentation, HEARTBEAT_MS, Heartbeat, outcome } from "../src/bullmq.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const events: TaskEvent[] = [];
const processor = new TracepanelProcessor(config, {
  submit: (done) => sent.push(done),
  submitEvent: (event) => events.push(event),
});
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Job {
  id: string;
  name: string;
  queueName: string;
  data: unknown;
  timestamp: number;
  attemptsMade: number;
  opts: { attempts?: number; "tracepanel-profile"?: string };
}

/** BullMQ's Queue, as far as the instrumentation sees it: add() and addBulk() resolve with the jobs they added. */
class Queue {
  static next = 0;
  constructor(readonly name: string) {}

  async add(name: string, data: unknown, opts: Job["opts"] = {}): Promise<Job> {
    return this.job(name, data, opts);
  }

  async addBulk(jobs: { name: string; data: unknown; opts?: Job["opts"] }[]): Promise<Job[]> {
    return jobs.map((job) => this.job(job.name, job.data, job.opts ?? {}));
  }

  private job(name: string, data: unknown, opts: Job["opts"]): Job {
    Queue.next += 1;
    return { id: String(Queue.next), name, queueName: this.name, data, timestamp: Date.now(), attemptsMade: 0, opts };
  }
}

/** BullMQ's Worker: run() until close(), each job through callProcessJob(). */
class Worker {
  private stop: () => void = () => {};
  readonly opts: { name?: string };

  constructor(
    readonly name: string,
    private readonly processor: (job: Job) => Promise<unknown>,
    opts: { name?: string } = {},
  ) {
    this.opts = opts;
  }

  callProcessJob(job: Job): Promise<unknown> {
    return this.processor(job);
  }

  run(): Promise<void> {
    return new Promise((done) => (this.stop = done));
  }

  async close(): Promise<void> {
    this.stop();
  }
}

const instrumentation = new BullMQInstrumentation(processor);
const [bullmq] = instrumentation.getModuleDefinitions();
bullmq?.patch?.({ Queue, Worker }, "6.3.17");

/** One job through the worker: run, with BullMQ's attempt count after it as BullMQ keeps it. */
async function perform(worker: Worker, job: Job): Promise<void> {
  try {
    await worker.callProcessJob(job);
  } catch {
    job.attemptsMade += 1;
  }
  // The job's trace is sent after its span ends.
  await pause(60);
}

beforeEach(() => {
  events.length = 0;
  sent.length = 0;
});

describe("task events", () => {
  it("are sent as a job is added in a request, linked to its enqueue step, its secrets masked", async () => {
    const root = tracer.startSpan("POST", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "POST", "url.path": "/signup" },
    });
    await context.with(trace.setSpan(context.active(), root), () =>
      new Queue("emails").add("welcome", { to: "ann@example.com", password: "hunter2" }),
    );
    root.end();
    await pause(60);

    const request = sent.at(-1) as Trace;
    const enqueue = request.spans.find((span) => span.kind === "task.enqueue");

    expect(events).toEqual([
      {
        event: "enqueued",
        system: "bullmq",
        id: `emails:${Queue.next}`,
        time: expect.any(Number),
        name: "welcome",
        queue: "emails",
        retries: 0,
        args: '{"to":"ann@example.com","password":"********"}',
        trace_id: request.id,
        span_id: enqueue?.id,
      },
    ]);
  });

  it("are sent for a job added outside a request, and for each of a bulk", async () => {
    const queue = new Queue("reports");
    await queue.add("daily", 7);
    await queue.addBulk([
      { name: "weekly", data: "x".repeat(300) },
      { name: "monthly", data: undefined },
    ]);

    expect(events.map(({ time: _, ...event }) => event)).toEqual([
      {
        event: "enqueued",
        system: "bullmq",
        id: `reports:${Queue.next - 2}`,
        name: "daily",
        queue: "reports",
        retries: 0,
        args: "7",
      },
      {
        event: "enqueued",
        system: "bullmq",
        id: `reports:${Queue.next - 1}`,
        name: "weekly",
        queue: "reports",
        retries: 0,
        args: `"${"x".repeat(199)}…`,
      },
      {
        event: "enqueued",
        system: "bullmq",
        id: `reports:${Queue.next}`,
        name: "monthly",
        queue: "reports",
        retries: 0,
      },
    ]);
  });

  it("say a worker is there as it runs, and a job added, started and finished in it", async () => {
    const worker = new Worker("emails", async () => "sent", { name: "mailer" });
    const running = worker.run();
    const job = await new Queue("emails").add("welcome", { to: "ann" });
    await perform(worker, job);
    await worker.close();
    await running;

    expect(events.map(({ time: _, ...event }) => event)).toEqual([
      { event: "heartbeat", system: "bullmq", id: "", worker: "mailer", ids: [] },
      {
        event: "enqueued",
        system: "bullmq",
        id: `emails:${job.id}`,
        name: "welcome",
        queue: "emails",
        retries: 0,
        args: '{"to":"ann"}',
      },
      {
        event: "started",
        system: "bullmq",
        id: `emails:${job.id}`,
        name: "welcome",
        queue: "emails",
        worker: "mailer",
        retries: 0,
        args: '{"to":"ann"}',
      },
      { event: "finished", system: "bullmq", id: `emails:${job.id}`, worker: "mailer", state: "SUCCESS" },
    ]);

    expect((sent.at(-1) as Trace).attrs["task.state"]).toBe("SUCCESS");
  });

  it("say a job will run again, with why, until its last attempt failed", async () => {
    const worker = new Worker(
      "emails",
      async () => {
        throw new Error("smtp down");
      },
      { name: "mailer" },
    );
    const job = await new Queue("emails").add("welcome", {}, { attempts: 2 });
    events.length = 0;

    await perform(worker, job);
    await perform(worker, job);

    expect(events.map(({ time: _, args: __, ...event }) => event)).toEqual([
      {
        event: "started",
        system: "bullmq",
        id: `emails:${job.id}`,
        name: "welcome",
        queue: "emails",
        worker: "mailer",
        retries: 0,
      },
      {
        event: "retried",
        system: "bullmq",
        id: `emails:${job.id}`,
        worker: "mailer",
        retries: 1,
        error: "Error: smtp down",
      },
      {
        event: "started",
        system: "bullmq",
        id: `emails:${job.id}`,
        name: "welcome",
        queue: "emails",
        worker: "mailer",
        retries: 1,
      },
      { event: "finished", system: "bullmq", id: `emails:${job.id}`, worker: "mailer", state: "FAILURE" },
    ]);

    expect(sent.map((done) => done.attrs["task.state"])).toEqual(["RETRY", "FAILURE"]);
  });

  it("name a worker without a name after its process", async () => {
    const worker = new Worker("emails", async () => undefined);
    const job = await new Queue("emails").add("welcome", {});
    events.length = 0;

    await perform(worker, job);

    expect(events.map((event) => event.worker)).toEqual([
      expect.stringMatching(`:${process.pid}$`),
      expect.any(String),
    ]);
  });
});

describe("a profiled trace's jobs", () => {
  /** The jobs a request adds, one with add() and two with addBulk(); `asked`, `reason`: how it asked for a profile. */
  async function addedIn(
    asked: string | undefined,
    reason: string | undefined,
    add: (queue: Queue) => Promise<unknown> = async (queue) => {
      await queue.add("receipt", { order: 7 });
      await queue.addBulk([
        { name: "invoice", data: 7 },
        { name: "label", data: 7, opts: { attempts: 3 } },
      ]);
    },
  ): Promise<Job[]> {
    const queue = new Queue("orders");
    const jobs: Job[] = [];
    const original = { add: queue.add, addBulk: queue.addBulk };
    queue.add = async (...args) => {
      const job = await original.add.apply(queue, args);
      jobs.push(job);
      return job;
    };
    queue.addBulk = async (...args) => {
      const added = await original.addBulk.apply(queue, args);
      jobs.push(...added);
      return added;
    };
    const root = tracer.startSpan("POST", {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": "POST",
        "url.path": "/orders",
        ...(asked ? { "tracepanel.profile": asked } : {}),
        ...(reason ? { "tracepanel.profile.reason": reason } : {}),
      },
    });
    await context.with(trace.setSpan(context.active(), root), () => add(queue));
    root.end();
    await pause(60);
    return jobs;
  }

  it("ask the worker for a profile in their options: what the request asked for", async () => {
    const memory = await addedIn("memory", "header");
    const time = await addedIn("1", "cookie");

    expect(memory.map((job) => job.opts)).toEqual([
      { "tracepanel-profile": "memory" },
      { "tracepanel-profile": "memory" },
      { attempts: 3, "tracepanel-profile": "memory" },
    ]);

    expect(time.map((job) => job.opts)).toEqual([
      { "tracepanel-profile": "1" },
      { "tracepanel-profile": "1" },
      { attempts: 3, "tracepanel-profile": "1" },
    ]);
  });

  it("ask from where the app's code called profile() on", async () => {
    const jobs = await addedIn(undefined, undefined, async (queue) => {
      await queue.add("before", 1);
      processor.profile(false);
      await queue.add("after", 1);
    });

    expect(jobs.map((job) => [job.name, job.opts])).toEqual([
      ["before", {}],
      ["after", { "tracepanel-profile": "1" }],
    ]);
  });

  it("ask nothing when the request didn't, or only the setting profiles it; the app's own option is kept", async () => {
    const plain = await addedIn(undefined, undefined);
    config.profile = true;
    let setting: Job[];
    try {
      setting = await addedIn(undefined, undefined);
    } finally {
      config.profile = false;
    }
    const own = await addedIn("memory", "header", async (queue) => {
      await queue.add("receipt", 7, { "tracepanel-profile": "1" });
    });

    expect(plain.map((job) => job.opts)).toEqual([{}, {}, { attempts: 3 }]);

    expect(setting.map((job) => job.opts)).toEqual([{}, {}, { attempts: 3 }]);

    expect(own.map((job) => job.opts)).toEqual([{ "tracepanel-profile": "1" }]);
  });

  it("are profiled by the worker, their profile.reason the parent's, and ask the same of the jobs they add", async () => {
    const [job, , plain] = await addedIn("memory", "header");
    const followUps: Job[] = [];
    const worker = new Worker("orders", async (run) => {
      const until = performance.now() + 20;
      while (performance.now() < until);
      if (run.name === "receipt") followUps.push(await new Queue("mail").add("send receipt", run.data));
    });
    sent.length = 0;
    await perform(worker, job as Job);
    const asked = sent.at(-1) as Trace;
    delete plain?.opts["tracepanel-profile"];
    await perform(worker, plain as Job);
    const unasked = sent.at(-1) as Trace;

    expect(asked.kind).toBe("task");
    expect(asked.attrs["profile.reason"]).toBe("parent");
    expect(asked.profile).toEqual(expect.objectContaining({ samples: expect.any(Number) }));

    expect(followUps.map((added) => added.opts)).toEqual([{ "tracepanel-profile": "memory" }]);

    expect(unasked.attrs["profile.reason"]).toBeUndefined();
    expect(unasked.profile).toBeUndefined();
  });
});

describe("what a job's run that threw comes to", () => {
  const job = (attemptsMade: number, attempts?: number) =>
    ({ name: "j", queueName: "q", timestamp: 0, attemptsMade, opts: { attempts } }) as Job;
  const named = (name: string, message = "boom") => Object.assign(new Error(message), { name });

  it("is another attempt while attempts are left, else a failure", () => {
    expect(outcome(job(0, 3), new Error("boom"))).toBe("retry");
    expect(outcome(job(2, 3), new Error("boom"))).toBe("failure");
    expect(outcome(job(0), new Error("boom"))).toBe("failure");
  });

  it("is a failure for an UnrecoverableError, attempts left or not", () => {
    expect(outcome(job(0, 3), named("UnrecoverableError"))).toBe("failure");
  });

  it("is neither for what a job throws to be moved on", () => {
    expect(outcome(job(0), named("DelayedError"))).toBe("moved");
    expect(outcome(job(0), named("WaitingChildrenError"))).toBe("moved");
    expect(outcome(job(0), new Error("bullmq:rateLimitExceeded"))).toBe("moved");
  });
});

describe("a worker's heartbeat", () => {
  afterEach(() => vi.useRealTimers());

  it("says the worker is there as it opens, then every 30 seconds with the jobs it runs, until it closes", () => {
    vi.useFakeTimers();
    const beats: TaskEvent[] = [];
    const heartbeat = new Heartbeat((event) => beats.push(event));

    heartbeat.open("mailer");
    heartbeat.started("mailer", "emails:2");
    heartbeat.started("mailer", "emails:1");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    heartbeat.ended("mailer", "emails:2");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    heartbeat.ended("mailer", "emails:1");
    heartbeat.close("mailer");
    vi.advanceTimersByTime(HEARTBEAT_MS);

    expect(beats.map(({ time: _, ...beat }) => beat)).toEqual([
      { event: "heartbeat", system: "bullmq", id: "", worker: "mailer", ids: [] },
      { event: "heartbeat", system: "bullmq", id: "", worker: "mailer", ids: ["emails:1", "emails:2"] },
      { event: "heartbeat", system: "bullmq", id: "", worker: "mailer", ids: ["emails:1"] },
    ]);
  });

  it("keeps a worker two instances share until both closed", () => {
    vi.useFakeTimers();
    const beats: TaskEvent[] = [];
    const heartbeat = new Heartbeat((event) => beats.push(event));

    heartbeat.open("host:1");
    heartbeat.open("host:1");
    heartbeat.close("host:1");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    heartbeat.close("host:1");
    vi.advanceTimersByTime(HEARTBEAT_MS);

    expect(beats.map((beat) => beat.worker)).toEqual(["host:1", "host:1", "host:1"]);
  });
});

describe("the agent", () => {
  it("hears in the hello that the app sends task events, once BullMQ loaded", () => {
    expect(hello(config).capabilities).toContain("live_tasks");
  });

  it("gets task events as a frame of their own, on a connection whose hello says what the app sends", async () => {
    const hellos: Record<string, unknown>[] = [];
    const frames: unknown[] = [];
    const agent = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      let greeted = false;
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf("\n");
        if (!greeted && newline >= 0) {
          greeted = true;
          hellos.push(JSON.parse(buffer.subarray(0, newline).toString()));
          buffer = buffer.subarray(newline + 1);
          socket.write('{"ok":true}\n');
        }
        while (greeted && buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
          const length = buffer.readUInt32BE(0);
          frames.push(JSON.parse(buffer.subarray(4, 4 + length).toString()));
          buffer = buffer.subarray(4 + length);
        }
      });
    });
    await new Promise<void>((done) => agent.listen(0, "127.0.0.1", done));
    const address = agent.address();
    process.env.TRACEPANEL_AGENT = `tcp:127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const sender = new Sender(config, new Starter(config.storeDir));
      sender.submitEvent({ event: "heartbeat", system: "bullmq", id: "", time: 1, worker: "mailer", ids: [] });
      sender.submit({ id: "T" } as unknown as Trace);
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      // Something else the app sends from now on: the next batch goes on a connection that says so.
      sends("more_events");
      sender.submitEvent({ event: "finished", system: "bullmq", id: "emails:1", time: 2 });
      await vi.waitFor(() => expect(frames).toHaveLength(3));

      expect(frames).toEqual([
        [{ id: "T" }],
        { tasks: [{ event: "heartbeat", system: "bullmq", id: "", time: 1, worker: "mailer", ids: [] }] },
        { tasks: [{ event: "finished", system: "bullmq", id: "emails:1", time: 2 }] },
      ]);

      expect(hellos.map((said) => said.capabilities)).toEqual([
        expect.arrayContaining(["explain", "live_tasks"]),
        expect.arrayContaining(["explain", "live_tasks", "more_events"]),
      ]);
    } finally {
      delete process.env.TRACEPANEL_AGENT;
      agent.close();
    }
  });
});
