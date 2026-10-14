// The app's own steps and traces. Outside development, and outside a trace, these run the function and nothing else.
//
//   await trace("rebuild index", async () => {
//     await span("load rows", () => loadRows());
//   });

import { type Attributes, trace as otel, SpanKind, SpanStatusCode } from "@opentelemetry/api";

const tracer = otel.getTracer("tracepanel");

async function run<T>(
  name: string,
  attributes: Attributes,
  kind: SpanKind,
  fn: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return tracer.startActiveSpan(name, { kind, attributes }, async (current): Promise<Awaited<T>> => {
    try {
      return await fn();
    } catch (error) {
      current.recordException(error as Error);
      current.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      current.end();
    }
  });
}

export interface TraceOptions {
  /** `command` (a script, a cron job; the default) or `task` (a job a worker took). */
  kind?: "command" | "task";
  /** Attributes of the trace: task.queue, task.id and the like. */
  attrs?: Attributes;
}

/** Runs the function as a trace of its own: a script, a scheduled job, a worker's job. Inside a trace, a step. */
export function trace<T>(name: string, fn: () => T | Promise<T>, options: TraceOptions = {}): Promise<Awaited<T>> {
  if (otel.getActiveSpan()) return span(name, fn, options.attrs);
  const attributes = { ...options.attrs, "tracepanel.kind": options.kind ?? "command", "tracepanel.name": name };
  return run(name, attributes, SpanKind.INTERNAL, fn);
}

/** Runs the function as a step of the current trace, with its SQL, calls and logs inside it. */
export function span<T>(name: string, fn: () => T | Promise<T>, attrs: Attributes = {}): Promise<Awaited<T>> {
  return run(name, attrs, SpanKind.INTERNAL, fn);
}
