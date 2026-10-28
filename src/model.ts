// The trace as every Tracepanel SDK sends it to the agent: schema/trace.schema.json in the tracepanel repository.

import { randomBytes } from "node:crypto";

export type Attrs = Record<string, unknown>;

export interface Span {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  start: number;
  duration: number;
  status: "ok" | "error";
  attrs: Attrs;
}

export interface Log {
  span_id: string | null;
  time: number;
  level: "debug" | "info" | "warning" | "error" | "critical";
  logger: string;
  message: string;
  exception: string | null;
  attrs: Attrs;
}

export interface Frame {
  filename: string;
  module: string;
  function: string;
  lineno: number;
  in_app: boolean;
  context_start: number | null;
  context: string[];
  /** The values of the frame's local variables, as text: the app's own frames, when they were read; else null. */
  locals: Record<string, string> | null;
}

export interface TraceError {
  span_id: string | null;
  time: number;
  type: string;
  message: string;
  handled: boolean;
  frames: Frame[];
  chain: unknown[];
}

export interface Trace {
  id: string;
  kind: "http" | "task" | "command" | "test";
  name: string;
  start: number;
  duration: number;
  status: "ok" | "error";
  attrs: Attrs;
  spans: Span[];
  logs: Log[];
  errors: TraceError[];
  links: unknown[];
  issues: unknown[];
  /** Where its time went in code, when it was profiled. */
  profile?: Profile;
}

/** A trace's profile: the functions its sampled stacks name, each once, and each stack as indexes into them. */
export interface Profile {
  interval_us: number;
  samples: number;
  frames: ProfileFrame[];
  stacks: { frames: number[]; count: number }[];
  /** What its code allocated, when its memory was asked for (memory.ts). */
  memory?: ProfileMemory;
  /** The garbage collector's runs while it ran. */
  gc?: { collections: number; pause_us: number; pauses: [number, number, number][] };
}

export interface ProfileMemory {
  peak: number;
  net: number;
  allocated?: number;
  /** Where the memory was at `sites_at`, largest first: each site's frames as indexes into the profile's. */
  sites: { frames: number[]; bytes: number; count: number }[];
  sites_at: "peak" | "end";
  shared: boolean;
}

export interface ProfileFrame {
  function: string;
  module: string | null;
  file: string;
  /** Where the function is defined. */
  line: number;
  in_app: boolean;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of milliseconds, 80 random bits, 26 characters of Crockford base32. */
export function newId(now: number = Date.now()): string {
  let value = (BigInt(now) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** Microseconds since the epoch, as the agent stores times. */
export function micros(ms: number): number {
  return Math.round(ms * 1000);
}

/** The most spans a trace is sent with, as the agent stores it; the rest are counted (`tracepanel.dropped_spans`). */
export const MAX_SPANS = 2000;
/** The most log records a trace keeps; the rest are counted (`tracepanel.dropped_logs`). */
export const MAX_LOGS = 1000;

/** Adds `count` to a trace's tally of what went unrecorded. */
export function countDropped(
  trace: Trace,
  key: "tracepanel.dropped_spans" | "tracepanel.dropped_logs" | "tracepanel.dropped_samples",
  count = 1,
): void {
  trace.attrs[key] = Number(trace.attrs[key] ?? 0) + count;
}

/**
 * The trace cut to MAX_SPANS: its earliest spans, its roots always. Spans end children first, so a cut as they end
 * would keep children whose parent went: by start, a parent always comes before its children.
 */
export function limited(trace: Trace): Trace {
  if (trace.spans.length <= MAX_SPANS) return trace;
  const ranked = trace.spans
    .map((span, index) => ({ span, index }))
    .sort(
      (a, b) => Number(a.span.parent_id !== null) - Number(b.span.parent_id !== null) || a.span.start - b.span.start,
    );
  const kept = new Set(ranked.slice(0, MAX_SPANS).map(({ index }) => index));
  countDropped(trace, "tracepanel.dropped_spans", trace.spans.length - kept.size);
  trace.spans = trace.spans.filter((_, index) => kept.has(index));
  return trace;
}
