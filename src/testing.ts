// Tests that hold the app to what Tracepanel finds: the queries a block makes, the issues the agent finds in a test.
// What a test runner's integration (vitest.ts) builds on, as the Python SDK's pytest plugin builds on its testing.py.
//
// A test runs as a trace of its own, kind `test`, named after the test. A request the test makes of the app in its
// process (supertest, fetch to a server it started) is an `http.client` span of that trace, and the app's trace of
// the request is a trace of its own that the request's traceparent links to it, as a call between two apps is. A
// test's queries are its own and those of the requests it made, and the agent's findings in all of those traces are
// the test's.

import { context, type Span as OtelSpan, trace as otel, ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Trace } from "./model.js";
import type { Sink, TracepanelProcessor } from "./processor.js";

// What the agent finds (its schema/trace.schema.json): the kinds a test can fail on.
export const KINDS = [
  "n+1",
  "duplicates",
  "slow-sql",
  "slow-http",
  "slow-call",
  "error",
  "long-transaction",
  "in-transaction",
  "htmx",
  "queue-wait",
  "blocking-call",
  "large-result",
] as const;
export type Kind = (typeof KINDS)[number];
/** What fails a test unless the settings say otherwise. */
export const DEFAULT_FAIL_ON: readonly Kind[] = ["n+1", "duplicates"];

// How long to wait for the agent to store a test's traces, and how often to ask.
const STORED_WAIT_MS = 5000;
const POLL_MS = 10;
// How long to wait for the traces of the requests a test made to be sent: one whose response never ended isn't.
const SETTLE_MS = 2000;
// A failure lists this many queries, and says how many more there were.
const MAX_LISTED = 20;
// A statement longer than this is cut in a failure's message.
const MAX_STATEMENT = 300;

/** A test's own rules gone wrong (a kind misspelled), or a helper used outside a test: the test fails with it. */
export class UsageError extends Error {
  override name = "TracepanelUsageError";
}

/** The kinds named: a list of them, or one; an unknown kind is a typo, and an error. */
export function kinds(value: unknown, where: string): Set<Kind> {
  const names = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (names === undefined || !names.every((name) => typeof name === "string")) {
    throw new UsageError(`${where}: a kind or a list of kinds, got ${JSON.stringify(value)}`);
  }
  const unknown = [...new Set(names.filter((name) => !(KINDS as readonly string[]).includes(name)))].sort();
  if (unknown.length > 0) {
    throw new UsageError(`${where}: unknown kind ${unknown.join(", ")} (the kinds: ${KINDS.join(", ")})`);
  }
  return new Set(names as Kind[]);
}

// ---------- the queries ----------

export function queries(spans: readonly Span[]): Span[] {
  return spans.filter((span) => span.kind === "sql");
}

function statementOf(span: Span): string {
  const text = String(span.attrs["db.statement"] || span.name)
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return text.length <= MAX_STATEMENT ? text : `${text.slice(0, MAX_STATEMENT)}…`;
}

/** Queries as a failure lists them: the statement, and where the project's code made it. */
export function listed(spans: readonly Span[]): string {
  const lines = spans.slice(0, MAX_LISTED).map((span) => {
    const where = span.attrs["code.origin"];
    return `  ${statementOf(span)}${where ? `\n    at ${where}` : ""}`;
  });
  if (spans.length > MAX_LISTED) lines.push(`  … and ${spans.length - MAX_LISTED} more`);
  return lines.join("\n");
}

export function tooMany(made: readonly Span[], limit: number): string {
  return `${made.length} queries, at most ${limit} expected:\n${listed(made)}`;
}

/** An assertion's failure as a test runner shows it: the message, without this SDK's frames. */
export function failure(message: string, name = "AssertionError"): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}`;
  return error;
}

// ---------- what the agent found ----------

/** An issue the agent found in a test's trace, or in the trace of a request the test made. */
export interface Finding {
  kind: string;
  title: string;
  /** Where in the project's code: `src/routes/users.ts:21 in list`. */
  culprit: string | null;
  hint: string | null;
  count: number;
  /** The statement of its first query, for an issue about SQL. */
  query: string | null;
  traceId: string;
  traceName: string;
  /** The trace in the agent's console. */
  url: string;
}

/** The finding as a failure lists it; the trace it is in unless it is the test's own (`test`, its id). */
export function describe(finding: Finding, test?: string): string {
  const lines = [finding.title];
  if (finding.query) lines.push(`  ${finding.query}`);
  if (finding.culprit) lines.push(`  at ${finding.culprit}`);
  if (finding.traceId !== test) lines.push(`  in ${finding.traceName} → ${finding.url}`);
  if (finding.hint) lines.push(`  ${finding.hint}`);
  return lines.join("\n");
}

export function traceUrl(console: string, traceId: string): string {
  return `${console.replace(/\/+$/, "")}/#/t/${traceId}`;
}

interface Summary {
  id: string;
  /** How many issues the agent found in the trace. */
  issues?: number;
}

interface Issue {
  kind: string;
  title: string;
  culprit?: string | null;
  hint?: string | null;
  count?: number;
  span_ids?: string[];
}

/** Outside any trace: the calls to the agent's console are the test's bookkeeping, not its work. */
function untraced<T>(fn: () => Promise<T>): Promise<T> {
  return context.with(ROOT_CONTEXT, fn);
}

/** The agent's console API, where a test's traces are read back with what the agent found in them. */
export class Console {
  constructor(readonly url: string) {}

  private async get(path: string, query?: Record<string, string>): Promise<unknown> {
    const address = `${this.url.replace(/\/+$/, "")}/api/${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
    return untraced(async () => {
      const answer = await fetch(address, { signal: AbortSignal.timeout(STORED_WAIT_MS) });
      if (answer.status === 404) return null;
      if (!answer.ok) throw new Error(`tracepanel: the agent's console answered ${answer.status} for ${address}`);
      return answer.json();
    });
  }

  /** The traces' summaries once the agent has stored them all (it writes in a thread of its own), by id. */
  async stored(ids: string[], timeoutMs = STORED_WAIT_MS): Promise<Map<string, Summary>> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const answer = (await this.get("traces", { ids: ids.join(","), limit: String(ids.length) })) as {
        traces?: Summary[];
      } | null;
      const found = new Map((answer?.traces ?? []).map((row) => [row.id, row]));
      if (found.size >= ids.length || performance.now() >= deadline) return found;
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  }

  /** What the agent found in these traces, the oldest trace's first. */
  async findings(traces: readonly Trace[]): Promise<Finding[]> {
    if (traces.length === 0) return [];
    const spans = new Map(traces.flatMap((trace) => trace.spans.map((span) => [span.id, span] as const)));
    const stored = await this.stored(traces.map((trace) => trace.id));
    const found: Finding[] = [];
    for (const trace of [...traces].sort((a, b) => a.start - b.start)) {
      if (!stored.get(trace.id)?.issues) continue;
      const document = ((await this.get(`traces/${trace.id}`)) ?? {}) as { issues?: Issue[] };
      for (const issue of document.issues ?? []) {
        const first = (issue.span_ids ?? []).map((id) => spans.get(id)).find((span) => span !== undefined);
        found.push({
          kind: issue.kind,
          title: issue.title,
          culprit: issue.culprit ?? null,
          hint: issue.hint ?? null,
          count: issue.count ?? 1,
          query: first?.kind === "sql" ? statementOf(first) : null,
          traceId: trace.id,
          traceName: trace.name,
          url: traceUrl(this.url, trace.id),
        });
      }
    }
    return found;
  }
}

// ---------- a test's trace ----------

const HOLDER = Symbol.for("tracepanel.testing");

interface Holder {
  /** The tests running now, by the W3C trace id of their trace: the requests they make carry it. */
  running: Map<string, TracedTest>;
}

function holder(): Holder {
  const global = globalThis as { [HOLDER]?: Holder };
  global[HOLDER] ??= { running: new Map() };
  return global[HOLDER];
}

/** Whether a test is running: what else completes now (a request in a beforeAll) is not a test's. */
export function running(): boolean {
  return holder().running.size > 0;
}

/** The test whose trace is current: the one running this code, or the one whose request the app is serving. */
export function currentTest(): TracedTest | undefined {
  const span = otel.getActiveSpan();
  return span ? holder().running.get(span.spanContext().traceId) : undefined;
}

/**
 * The agent's sink with the tests' traces taken aside: each goes out at once, as its test waits for what the agent
 * found in it; what completes while no test runs (a request a beforeAll made) isn't sent at all, nor is anything
 * without an agent (`send`: there is one).
 */
export class TestSink implements Sink {
  constructor(
    private readonly sink: Sink & { flushNow?(): void },
    private readonly send: boolean,
  ) {}

  submit(trace: Trace): void {
    const test = holder().running.get(String(trace.attrs["w3c.trace_id"] ?? ""));
    if (test) test.completed(trace);
    if (!this.send || (trace.kind !== "test" && !running())) return;
    this.sink.submit(trace);
    this.sink.flushNow?.();
  }

  submitEvent(event: Record<string, unknown>): void {
    if (this.send) this.sink.submitEvent?.(event);
  }
}

/** A test run as a trace: what a test runner's integration records, and what testTrace() gives a test. */
export class TracedTest {
  /** The test's own trace, once it is sent. */
  trace: Trace | undefined;
  /** The app's traces of the requests the test made. */
  readonly served: Trace[] = [];
  private root: OtelSpan | undefined;

  constructor(
    readonly name: string,
    private readonly attrs: Record<string, string | number>,
    private readonly processor: TracepanelProcessor,
    /** The agent's console, or undefined without an agent. */
    readonly console: Console | undefined,
  ) {}

  /** Runs the test as the trace: `run` runs it, `failed` says after it whether it failed (and with what). */
  async record(run: () => Promise<void>, failed: () => readonly unknown[]): Promise<void> {
    const tracer = otel.getTracer("tracepanel");
    const attributes = { ...this.attrs, "tracepanel.kind": "test", "tracepanel.name": this.name };
    try {
      await tracer.startActiveSpan(this.name, { attributes }, async (root) => {
        this.root = root;
        holder().running.set(this.traceId, this);
        try {
          await run();
        } finally {
          const errors = failed();
          for (const error of errors) root.recordException(exception(error));
          if (errors.length > 0) root.setStatus({ code: SpanStatusCode.ERROR });
          root.end();
        }
      });
      // The test's trace goes out a moment after its root span ends, with the spans that ended meanwhile; its
      // requests' traces, once their responses have.
      await this.settle(false);
    } finally {
      holder().running.delete(this.traceId);
    }
  }

  private get traceId(): string {
    return this.root?.spanContext().traceId ?? "";
  }

  /** A trace of this test's sent: its own, or the app's of a request it made. */
  completed(trace: Trace): void {
    if (trace.kind === "test") this.trace = trace;
    else this.served.push(trace);
  }

  /**
   * Waits for the traces of the requests the test made to be sent; `running`: the test's own trace still is, else
   * it is waited for too.
   */
  async settle(running = true): Promise<void> {
    const except = running ? this.root?.spanContext().spanId : undefined;
    const deadline = performance.now() + SETTLE_MS;
    while (this.processor.building(this.traceId, except).length > 0 && performance.now() < deadline) {
      await untraced(() => new Promise((done) => setTimeout(done, 5)));
    }
  }

  /** The test's own spans so far. */
  ownSpans(): Span[] {
    if (this.trace) return this.trace.spans;
    const spanId = this.root?.spanContext().spanId;
    return (spanId ? this.processor.openTrace(spanId)?.spans : undefined) ?? [];
  }

  /** The test's trace and those of its requests, as far as they are recorded. */
  get traces(): Trace[] {
    return [...(this.trace ? [this.trace] : []), ...this.served];
  }

  /** The traces of the requests the test made, those whose trace isn't sent yet included (their spans so far). */
  private requests(): Trace[] {
    return [...this.served, ...this.processor.building(this.traceId, this.root?.spanContext().spanId)];
  }

  /** The queries the test made so far, its requests' included. */
  get sql(): Span[] {
    return [...queries(this.ownSpans()), ...this.requests().flatMap((trace) => queries(trace.spans))];
  }

  get queries(): number {
    return this.sql.length;
  }

  /**
   * What the agent found so far: in the requests the test made; its own trace's once the test has ended. Empty
   * without an agent.
   */
  async issues(): Promise<Finding[]> {
    if (!this.console) return [];
    await this.settle(this.trace === undefined);
    return this.console.findings(this.trace ? this.traces : this.served);
  }

  /** The test's trace in the agent's console. */
  get url(): string | undefined {
    const id = this.trace?.id ?? this.ownId();
    return this.console && id ? traceUrl(this.console.url, id) : undefined;
  }

  private ownId(): string | undefined {
    const spanId = this.root?.spanContext().spanId;
    return spanId ? this.processor.openTrace(spanId)?.id : undefined;
  }
}

/** A test runner's error as an exception on the test's root span: the trace's error. */
function exception(error: unknown): { name: string; message: string; stack?: string } {
  if (error && typeof error === "object") {
    const { name, message, stack } = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof name === "string" && name ? name : "Error",
      message: typeof message === "string" ? message : String(error),
      ...(typeof stack === "string" ? { stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

/** What fails a test: more queries than `maxQueries`, or an issue the agent found of a kind in `failOn`. */
export interface Rules {
  failOn: Set<Kind>;
  maxQueries: number | undefined;
}

/** What the test did against its rules: a failure's message each, none when it held to them. */
export async function problems(
  run: TracedTest,
  rules: Rules,
  allowedHow: (kinds: string) => string,
): Promise<string[]> {
  const found: string[] = [];
  if (rules.maxQueries !== undefined && run.queries > rules.maxQueries) found.push(tooMany(run.sql, rules.maxQueries));
  if (rules.failOn.size > 0 && run.console) {
    const failing = (await run.console.findings(run.traces)).filter((finding) =>
      rules.failOn.has(finding.kind as Kind),
    );
    if (failing.length > 0) {
      const listedFindings = failing.map((finding) => describe(finding, run.trace?.id)).join("\n\n");
      const allow = [...new Set(failing.map((finding) => finding.kind))]
        .sort()
        .map((kind) => `"${kind}"`)
        .join(", ");
      found.push(
        `tracepanel found ${failing.length} ${failing.length === 1 ? "issue" : "issues"} in this test:\n\n` +
          `${listedFindings}\n\nThe test's trace: ${run.url}\n${allowedHow(allow)}`,
      );
    }
  }
  return found;
}

/**
 * Fails (an AssertionError) when `fn` makes more than `limit` SQL queries, those of the requests it makes included.
 *
 *   await maxQueries(3, () => request(app).get("/posts"));
 *
 * It counts in the current test's trace.
 */
export async function maxQueries<T>(limit: number, fn: () => T | Promise<T>): Promise<Awaited<T>> {
  const test = currentTest();
  if (!test) {
    throw new UsageError(
      "maxQueries() counts the queries of a test's trace, and none is running: add tracepanel() to the plugins of the Vitest config",
    );
  }
  const before = new Set(test.sql.map((span) => span.id));
  const result = await fn();
  const made = test.sql.filter((span) => !before.has(span.id));
  if (made.length > limit) throw failure(tooMany(made, limit));
  return result;
}
