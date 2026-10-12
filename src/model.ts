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
  locals: Record<string, string>;
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
  kind: "http" | "task" | "command";
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
