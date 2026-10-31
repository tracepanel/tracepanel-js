// The app's own steps and traces, and who the request is for. Outside development, and outside a trace, these run
// the function and nothing else.
//
//   await trace("rebuild index", async () => {
//     await span("load rows", () => loadRows());
//   });
//   setUser({ id: customer.id, username: customer.email });
//   profile({ memory: true });

import { type Attributes, trace as otel, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Runtime } from "./runtime.js";

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

/** The signed-in user, as the Python SDK names one: `user.id`, and the username and email if the app gives them. */
export interface User {
  id: string | number;
  username?: string;
  email?: string;
}

const RUNTIME = Symbol.for("tracepanel.runtime");

/**
 * Names the signed-in user on the current trace (`null`: nobody is signed in), so the console shows whose request
 * it was and finds a user's traces. The username and email stay on this machine: the agent drops them before
 * anything leaves it.
 */
export function setUser(user: User | null): void {
  // From the process's Tracepanel on globalThis: code bundled apart from the SDK (a Next.js route) reaches it too.
  const tracepanel = (globalThis as { [RUNTIME]?: Runtime })[RUNTIME];
  if (!tracepanel) return;
  if (user === null) {
    tracepanel.processor.setTraceAttrs({ "user.id": null });
    return;
  }
  tracepanel.processor.setTraceAttrs({
    "user.id": String(user.id),
    ...(user.username === undefined ? {} : { "user.username": user.username }),
    ...(user.email === undefined ? {} : { "user.email": user.email }),
  });
}

export interface ProfileOptions {
  /** Where the trace's memory goes too, not only its CPU time. */
  memory?: boolean;
}

/**
 * Profiles the rest of the current trace (`profile.reason` "code", unless it is profiled already), its memory too
 * with `{ memory: true }`; the calls it makes to other apps from now on ask them for a profile too. Whether the trace
 * is profiled: false outside a trace, outside development, or with profiling off (TRACEPANEL_PROFILE_ENABLED=0).
 */
export function profile(options: ProfileOptions = {}): boolean {
  const tracepanel = (globalThis as { [RUNTIME]?: Runtime })[RUNTIME];
  if (!tracepanel) return false;
  return tracepanel.processor.profile(options.memory === true);
}
