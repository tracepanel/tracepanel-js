// BullMQ: each job a worker runs is a task trace, and each job the app adds is a task.enqueue step of the request
// that added it, as the Python SDK records Celery's and RQ's.

import { type Attributes, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from "@opentelemetry/instrumentation";

interface Job {
  id?: string;
  name: string;
  queueName: string;
  timestamp: number;
  delay?: number;
  attemptsMade: number;
  opts?: { attempts?: number };
}

type Process = (this: unknown, job: Job, ...rest: unknown[]) => Promise<unknown>;
type Add = (this: { name: string }, name: string, ...rest: unknown[]) => Promise<{ id?: string } | undefined>;

interface BullMQ {
  Worker?: { prototype: { callProcessJob: Process } };
  Queue?: { prototype: { add: Add } };
}

const SYSTEM = "bullmq";

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

export class BullMQInstrumentation extends InstrumentationBase {
  constructor() {
    super("tracepanel-bullmq", "1.0.0", {});
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition("bullmq", [">=5"], (exports: BullMQ) => {
      const worker = exports.Worker?.prototype;
      if (typeof worker?.callProcessJob === "function" && !isWrapped(worker.callProcessJob)) {
        this._wrap(worker, "callProcessJob", (original: Process) => this.processJob(original));
      }
      const queue = exports.Queue?.prototype;
      if (typeof queue?.add === "function" && !isWrapped(queue.add)) {
        this._wrap(queue, "add", (original: Add) => this.add(original));
      }
      return exports;
    });
  }

  private processJob(original: Process): Process {
    const tracer = this.tracer;
    return function (this: unknown, job: Job, ...rest: unknown[]) {
      const attributes = { ...taskAttrs(job), "tracepanel.kind": "task", "tracepanel.name": job.name };
      return tracer.startActiveSpan(job.name, { kind: SpanKind.CONSUMER, attributes }, async (span) => {
        try {
          const result = await original.call(this, job, ...rest);
          span.setAttribute("task.state", "SUCCESS");
          return result;
        } catch (error) {
          // BullMQ tries again while attempts are left: this run is a retry, the last one a failure.
          const retried = job.attemptsMade + 1 < (job.opts?.attempts ?? 1);
          span.setAttribute("task.state", retried ? "RETRY" : "FAILURE");
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    };
  }

  private add(original: Add): Add {
    const tracer = this.tracer;
    return function (this: { name: string }, name: string, ...rest: unknown[]) {
      // Outside a request or a task (a script adding jobs) there is no trace to add the step to.
      if (!trace.getActiveSpan()) return original.call(this, name, ...rest);
      const attributes = {
        "tracepanel.span_kind": "task.enqueue",
        "task.system": SYSTEM,
        "task.name": name,
        "task.queue": this.name,
      };
      return tracer.startActiveSpan(`enqueue ${name}`, { kind: SpanKind.PRODUCER, attributes }, async (span) => {
        try {
          const job = await original.call(this, name, ...rest);
          if (job?.id) span.setAttribute("task.id", job.id);
          return job;
        } finally {
          span.end();
        }
      });
    };
  }
}
