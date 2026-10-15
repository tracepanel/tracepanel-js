import { describe, expect, it } from "vitest";
import { limited, MAX_SPANS, newId, type Span, type Trace } from "../src/model.js";

describe("newId", () => {
  it("is a ULID: 26 Crockford characters, ordered by time", () => {
    const earlier = newId(1_700_000_000_000);
    const later = newId(1_700_000_000_001);
    expect(earlier).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
  });
});

/** A trace with `count` spans, each the child of the one before, ending children first as OpenTelemetry ends them. */
function deep(count: number): Trace {
  const spans: Span[] = Array.from({ length: count }, (_, n) => ({
    id: `s${n}`,
    parent_id: n === 0 ? null : `s${n - 1}`,
    kind: "function",
    name: "step",
    start: n,
    duration: 1,
    status: "ok" as const,
    attrs: {},
  })).reverse();
  return {
    id: "T",
    kind: "http",
    name: "GET /",
    start: 0,
    duration: count,
    status: "ok",
    attrs: {},
    spans,
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

describe("limited", () => {
  it("cuts a trace to its earliest spans, each kept with its parent, and counts the rest", () => {
    const trace = limited(deep(MAX_SPANS + 500));
    const kept = new Set(trace.spans.map((span) => span.id));

    expect(trace.spans).toHaveLength(MAX_SPANS);
    expect(kept.has("s0")).toBe(true);
    expect(trace.spans.every((span) => span.parent_id === null || kept.has(span.parent_id))).toBe(true);
    expect(trace.attrs).toEqual({ "tracepanel.dropped_spans": 500 });
  });

  it("leaves a trace within the limit as it is", () => {
    const trace = deep(3);

    expect(limited(trace)).toEqual(deep(3));
  });
});
