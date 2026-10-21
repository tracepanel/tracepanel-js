// BullMQ: each job a worker runs is a task trace, and each job the app adds is a task.enqueue step of the request
// that added it, as the Python SDK records Celery's and RQ's.
//
// A job's trace reaches the agent when it ends. Until then task events say where it is, for the console's Live list:
// `enqueued` as the app adds it (with the request and step that added it), `started` as a worker takes it, then
// `retried` (with the error) when BullMQ will run it again, or `finished`. A worker says it is there as it starts
// running, and every 30 seconds each process sends a `heartbeat` per worker with the jobs it runs, so a job whose
// process was killed leaves the list. A job's id there is its queue's name and its id: BullMQ counts ids per queue.

import { hostname } from "node:os";
import { type Attributes, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from "@opentelemetry/instrumentation";
import { sends, type TaskEvent } from "./agent.js";
import { masked } from "./request.js";

interface Job {
  id?: string;
  name: string;
  queueName: string;
  data?: unknown;
  timestamp: number;
  delay?: number;
  attemptsMade: number;
  opts?: { attempts?: number };
}

interface Worker {
  opts?: { name?: string };
}

type Process = (this: Worker, job: Job, ...rest: unknown[]) => Promise<unknown>;
type Add = (this: { name: string }, name: string, ...rest: unknown[]) => Promise<Job | undefined>;
type AddBulk = (this: { name: string }, jobs: unknown[]) => Promise<Job[] | undefined>;
type Lifecycle = (this: Worker, ...rest: unknown[]) => Promise<unknown>;

interface BullMQ {
  Worker?: { prototype: { callProcessJob: Process; run: Lifecycle } };
  Queue?: { prototype: { add: Add; addBulk: AddBulk } };
}

/** Where task events go: the process's Tracepanel (its processor), which knows the active trace too. */
export interface Events {
  taskEvent(event: TaskEvent): void;
  current(): { building: { trace: { id: string } }; spanId: string | null } | undefined;
}

const SYSTEM = "bullmq";
/** How often a worker says it is alive, with the jobs it runs: the agent drops a running one after 2 minutes. */
export const HEARTBEAT_MS = 30_000;
/** Arguments in a task event are for a glance at a list. */
const MAX_EVENT_REPR = 200;
/** What a job throws to be moved on, not because it failed (job.moveToDelayed(), a rate limit, its children). */
const MOVED = new Set(["DelayedError", "WaitingError", "WaitingChildrenError", "RateLimitError"]);
const RATE_LIMITED = "bullmq:rateLimitExceeded";

function taskAttrs(job: Job): Attributes {
  const enqueued = job.timestamp + (job.delay ?? 0);
  return {
    "task.system": SYSTEM,
    "task.name": job.name,
    "task.id": job.id ?? "",
    "task.queue": job.queueName,
    "task.retries": job.attemptsMade,
    "task.eager": false,
    // How long it waited for a worker, in microseconds: the agent's queue-wait issue.
    "task.queue_wait": Math.max(Date.now() - enqueued, 0) * 1000,
  };
}

/** What becomes of a job whose run threw: run again, failed, or moved on by the job itself. */
export function outcome(job: Job, error: unknown): "retry" | "failure" | "moved" {
  const { name, message } = error instanceof Error ? error : { name: "", message: "" };
  if (MOVED.has(name) || message === RATE_LIMITED) return "moved";
  // As BullMQ decides: attempts left, and not an UnrecoverableError.
  const left = job.attemptsMade + 1 < (job.opts?.attempts ?? 1);
  return left && name !== "UnrecoverableError" ? "retry" : "failure";
}

/** The job's id in task events: unique across queues. */
export function liveId(queue: string, id: string): string {
  return `${queue}:${id}`;
}

/** A job's data at a glance: as JSON, values under sensitive keys masked, cut short. */
export function eventArgs(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(masked(data)) ?? String(data);
  } catch {
    text = String(data);
  }
  return text.length <= MAX_EVENT_REPR ? text : `${text.slice(0, MAX_EVENT_REPR)}…`;
}

function reason(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length <= MAX_EVENT_REPR ? text : `${text.slice(0, MAX_EVENT_REPR)}…`;
}

/** The worker's name: the one the app gave it, or this process's. */
export function workerName(worker: Worker): string {
  return worker.opts?.name || `${hostname()}:${process.pid}`;
}

/**
 * The process's workers and the jobs each runs now, with one timer for their heartbeats. Two Worker instances under
 * one name (the default, this process's) are one worker to the console.
 */
export class Heartbeat {
  private readonly workers = new Map<string, { open: number; running: Set<string> }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly send: (event: TaskEvent) => void) {}

  /** A worker starts: the console lists it before it runs anything. */
  open(worker: string): void {
    this.of(worker).open += 1;
    this.beat(worker);
  }

  /** A worker closed: no more heartbeats for it once no instance under its name is open, nor a job running. */
  close(worker: string): void {
    const state = this.workers.get(worker);
    if (!state) return;
    state.open = Math.max(state.open - 1, 0);
    this.forget(worker);
  }

  started(worker: string, id: string): void {
    this.of(worker).running.add(id);
  }

  ended(worker: string, id: string): void {
    this.workers.get(worker)?.running.delete(id);
    this.forget(worker);
  }

  beat(worker: string): void {
    const ids = [...(this.workers.get(worker)?.running ?? [])].sort();
    this.send({ event: "heartbeat", system: SYSTEM, id: "", time: Date.now() * 1000, worker, ids });
  }

  private of(worker: string): { open: number; running: Set<string> } {
    let state = this.workers.get(worker);
    if (!state) {
      state = { open: 0, running: new Set() };
      this.workers.set(worker, state);
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const name of this.workers.keys()) this.beat(name);
      }, HEARTBEAT_MS);
      this.timer.unref();
    }
    return state;
  }

  private forget(worker: string): void {
    const state = this.workers.get(worker);
    if (state && state.open === 0 && state.running.size === 0) this.workers.delete(worker);
    if (this.workers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export class BullMQInstrumentation extends InstrumentationBase {
  private readonly heartbeat: Heartbeat;

  /** `events`: where task events go; without it, none are sent. */
  constructor(private readonly events?: Events) {
    super("tracepanel-bullmq", "1.0.0", {});
    this.heartbeat = new Heartbeat((event) => this.send(event));
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition("bullmq", [">=5"], (exports: BullMQ) => {
      const worker = exports.Worker?.prototype;
      if (typeof worker?.callProcessJob === "function" && !isWrapped(worker.callProcessJob)) {
        this._wrap(worker, "callProcessJob", (original: Process) => this.processJob(original));
      }
      if (typeof worker?.run === "function" && !isWrapped(worker.run)) {
        this._wrap(worker, "run", (original: Lifecycle) => this.run(original));
      }
      const queue = exports.Queue?.prototype;
      if (typeof queue?.add === "function" && !isWrapped(queue.add)) {
        this._wrap(queue, "add", (original: Add) => this.add(original));
      }
      if (typeof queue?.addBulk === "function" && !isWrapped(queue.addBulk)) {
        this._wrap(queue, "addBulk", (original: AddBulk) => this.addBulk(original));
      }
      // Its task events: the console's Live list of tasks.
      if (this.events) sends("live_tasks");
      return exports;
    });
  }

  private send(event: TaskEvent): void {
    this.events?.taskEvent(event);
  }

  /** A task event: what this step knows, undefined fields left out. */
  private event(event: string, id: string, fields: Record<string, unknown>): void {
    const known = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    this.send({ event, system: SYSTEM, id, time: Date.now() * 1000, ...known });
  }

  /** The job waits in its queue (or until its delay is over), sent by the process that added it. */
  private enqueued(queue: string, job: Job | undefined, parent?: { traceId: string; spanId: string }): void {
    if (!job?.id) return;
    this.event("enqueued", liveId(queue, job.id), {
      name: job.name,
      queue,
      retries: job.attemptsMade ?? 0,
      args: eventArgs(job.data),
      trace_id: parent?.traceId,
      span_id: parent?.spanId,
    });
  }

  /** The trace and step the app is in now, for a job added there. */
  private parent(): { traceId: string; spanId: string } | undefined {
    const current = this.events?.current();
    return current?.spanId ? { traceId: current.building.trace.id, spanId: current.spanId } : undefined;
  }

  private processJob(original: Process): Process {
    const instrumentation = this;
    const tracer = this.tracer;
    return function (this: Worker, job: Job, ...rest: unknown[]) {
      const worker = workerName(this);
      const id = liveId(job.queueName, job.id ?? "");
      instrumentation.heartbeat.started(worker, id);
      instrumentation.event("started", id, {
        name: job.name,
        queue: job.queueName,
        worker,
        retries: job.attemptsMade,
        args: eventArgs(job.data),
      });
      const attributes = { ...taskAttrs(job), "tracepanel.kind": "task", "tracepanel.name": job.name };
      return tracer.startActiveSpan(job.name, { kind: SpanKind.CONSUMER, attributes }, async (span) => {
        let failed: unknown;
        let threw = false;
        try {
          const result = await original.call(this, job, ...rest);
          span.setAttribute("task.state", "SUCCESS");
          return result;
        } catch (error) {
          threw = true;
          failed = error;
          // BullMQ tries again while attempts are left: this run is a retry, the last one a failure.
          span.setAttribute("task.state", outcome(job, error) === "failure" ? "FAILURE" : "RETRY");
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
          instrumentation.heartbeat.ended(worker, id);
          instrumentation.ended(job, id, worker, threw, failed);
        }
      });
    };
  }

  /** `retried` when BullMQ runs the job again (its next attempt's count), else `finished`. */
  private ended(job: Job, id: string, worker: string, threw: boolean, error: unknown): void {
    const after = threw ? outcome(job, error) : undefined;
    if (after === "retry") {
      this.event("retried", id, { worker, retries: job.attemptsMade + 1, error: reason(error) });
    } else if (after === "moved") {
      // Back in its queue (delayed, rate limited, waiting for its children): no attempt counted.
      this.event("retried", id, { worker, retries: job.attemptsMade });
    } else {
      this.event("finished", id, { worker, state: after === "failure" ? "FAILURE" : "SUCCESS" });
    }
  }

  /** A worker runs from here until it closes: the console lists it meanwhile. */
  private run(original: Lifecycle): Lifecycle {
    const heartbeat = this.heartbeat;
    return function (this: Worker, ...rest: unknown[]) {
      const worker = workerName(this);
      heartbeat.open(worker);
      return original.apply(this, rest).finally(() => heartbeat.close(worker));
    };
  }

  private add(original: Add): Add {
    const instrumentation = this;
    const tracer = this.tracer;
    return function (this: { name: string }, name: string, ...rest: unknown[]) {
      const queue = this.name;
      // Outside a request or a task (a script adding jobs) there is no trace to add the step to.
      if (!trace.getActiveSpan()) {
        return original.call(this, name, ...rest).then((job) => {
          instrumentation.enqueued(queue, job);
          return job;
        });
      }
      const attributes = {
        "tracepanel.span_kind": "task.enqueue",
        "task.system": SYSTEM,
        "task.name": name,
        "task.queue": queue,
      };
      return tracer.startActiveSpan(`enqueue ${name}`, { kind: SpanKind.PRODUCER, attributes }, async (span) => {
        const parent = instrumentation.parent();
        try {
          const job = await original.call(this, name, ...rest);
          if (job?.id) span.setAttribute("task.id", job.id);
          instrumentation.enqueued(queue, job, parent);
          return job;
        } finally {
          span.end();
        }
      });
    };
  }

  private addBulk(original: AddBulk): AddBulk {
    const instrumentation = this;
    return function (this: { name: string }, jobs: unknown[]) {
      const queue = this.name;
      const parent = instrumentation.parent();
      return original.call(this, jobs).then((added) => {
        for (const job of added ?? []) instrumentation.enqueued(queue, job, parent);
        return added;
      });
    };
  }
}
