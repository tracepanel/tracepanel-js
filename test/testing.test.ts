// What a test runner's integration builds on: a test's trace and its requests', their queries, and what the agent's
// console says it found in them.
import { createServer, type Server } from "node:http";
import { context, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, expect, describe as group, test } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { Span, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import {
  Console,
  describe,
  type Finding,
  kinds,
  maxQueries,
  problems,
  TestSink,
  TracedTest,
  tooMany,
  UsageError,
} from "../src/testing.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, new TestSink({ submit: (made) => sent.push(made) }, true));
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

const ATTRS = {
  "test.case.name": "books.test.ts > lists the books",
  "code.filepath": "books.test.ts",
  "code.lineno": 7,
  "code.function": "lists the books",
};

function query(sql: string, values: string[]): void {
  tracer
    .startSpan(`pg.query:${sql.split(" ")[0]}`, {
      kind: SpanKind.CLIENT,
      attributes: { "db.system.name": "postgresql", "db.query.text": sql, "db.postgresql.values": values },
    })
    .end();
}

/** The app serving a request the test made: its trace carries the test's trace id, as the request's traceparent. */
function serve(path: string, handler: () => void): void {
  const caller = trace.getActiveSpan()?.spanContext();
  const parent = caller
    ? trace.setSpanContext(ROOT_CONTEXT, { ...caller, spanId: "00f067aa0ba902b7", isRemote: true })
    : ROOT_CONTEXT;
  const root = tracer.startSpan(
    "GET",
    { kind: SpanKind.SERVER, attributes: { "http.request.method": "GET", "url.path": path } },
    parent,
  );
  context.with(trace.setSpan(parent, root), handler);
  root.end();
}

function statements(spans: readonly Span[]): unknown[] {
  return spans.map((span) => [span.attrs["db.statement"], span.attrs["code.origin"]]);
}

test("kinds are a kind or a list of them, and a misspelled one is an error", () => {
  expect(kinds("n+1", "allow")).toEqual(new Set(["n+1"]));
  expect(kinds(["n+1", "slow-sql", "n+1"], "allow")).toEqual(new Set(["n+1", "slow-sql"]));
  expect(kinds([], "allow")).toEqual(new Set());

  expect(() => kinds(["n+2", "dupes", "n+1"], "failOn")).toThrow(
    new UsageError(
      "failOn: unknown kind dupes, n+2 (the kinds: n+1, duplicates, slow-sql, slow-http, slow-call, error, " +
        "long-transaction, in-transaction, htmx, queue-wait, blocking-call, large-result)",
    ),
  );
  expect(() => kinds(3, "allow")).toThrow(new UsageError("allow: a kind or a list of kinds, got 3"));
});

test("too many queries are listed with where the code made them, the first twenty", () => {
  const span = (index: number): Span => ({
    id: String(index),
    parent_id: "root",
    kind: "sql",
    name: "SELECT authors",
    start: 0,
    duration: 0,
    status: "ok",
    attrs: {
      "db.statement": `SELECT name\n    FROM authors WHERE id = ${index}`,
      "code.origin": index === 1 ? null : "src/books.ts:12 in list",
    },
  });
  const long: Span = { ...span(0), attrs: { "db.statement": `SELECT ${"x, ".repeat(150)}y FROM t` } };

  expect(tooMany([long, ...Array.from({ length: 21 }, (_, index) => span(index + 1))], 3)).toBe(
    [
      "22 queries, at most 3 expected:",
      `  ${`SELECT ${"x, ".repeat(150)}`.slice(0, 300)}…`,
      "  SELECT name FROM authors WHERE id = 1",
      ...Array.from({ length: 18 }, (_, index) => [
        `  SELECT name FROM authors WHERE id = ${index + 2}`,
        "    at src/books.ts:12 in list",
      ]).flat(),
      "  … and 2 more",
    ].join("\n"),
  );
});

test("a finding names its query, the line that made it, its trace unless the test's own, and the hint", () => {
  const finding: Finding = {
    kind: "n+1",
    title: "N+1: 4 similar queries · SELECT authors",
    culprit: "src/books.ts:12 in list",
    hint: "Load the related rows with the parent rows (a join, or one batched query) instead of one query per row.",
    count: 4,
    query: "SELECT name FROM authors WHERE id = $1",
    traceId: "01M5VH6BFMFPA7X692DKQV2ANZ",
    traceName: "GET /books",
    url: "http://127.0.0.1:9/#/t/01M5VH6BFMFPA7X692DKQV2ANZ",
  };

  expect(describe(finding)).toBe(
    [
      "N+1: 4 similar queries · SELECT authors",
      "  SELECT name FROM authors WHERE id = $1",
      "  at src/books.ts:12 in list",
      "  in GET /books → http://127.0.0.1:9/#/t/01M5VH6BFMFPA7X692DKQV2ANZ",
      "  Load the related rows with the parent rows (a join, or one batched query) instead of one query per row.",
    ].join("\n"),
  );

  expect(describe({ ...finding, culprit: null, hint: null, query: null }, finding.traceId)).toBe(
    "N+1: 4 similar queries · SELECT authors",
  );
});

group("a test's trace", () => {
  test("is a trace of kind test with the test's attributes, and its queries and its requests' count", async () => {
    sent.length = 0;
    const run = new TracedTest("books.test.ts > lists the books", ATTRS, processor, undefined);
    let during: unknown;

    await run.record(
      async () => {
        query("SELECT id FROM books", []);
        serve("/books", () => {
          query("SELECT name FROM authors WHERE id = $1", ["1"]);
          query("SELECT name FROM authors WHERE id = $1", ["2"]);
        });
        // The request's trace waits a moment for its late spans: its queries count already.
        during = [run.queries, run.served.length];
      },
      () => [],
    );

    expect(during).toEqual([3, 0]);

    expect(run.queries).toBe(3);
    expect(statements(run.sql)).toEqual([
      ["SELECT id FROM books", null],
      ["SELECT name FROM authors WHERE id = $1", null],
      ["SELECT name FROM authors WHERE id = $1", null],
    ]);
    expect(run.served.map((made) => made.name)).toEqual(["GET /books"]);
    expect(sent.map((made) => [made.kind, made.name])).toEqual([
      ["http", "GET /books"],
      ["test", "books.test.ts > lists the books"],
    ]);

    const own = sent[1] as Trace;
    expect(own.status).toBe("ok");
    expect(own.attrs).toEqual({
      ...ATTRS,
      "service.name": "shop",
      "service.role": "test",
      "telemetry.sdk.language": "nodejs",
      "process.runtime.name": "node",
      "process.runtime.version": process.versions.node,
      "w3c.trace_id": expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(own.spans.map((span) => [span.kind, span.name])).toEqual([
      ["sql", "SELECT books"],
      ["function", "books.test.ts > lists the books"],
    ]);
    expect(sent[0]?.attrs["w3c.trace_id"]).toBe(own.attrs["w3c.trace_id"]);
  });

  test("has the test's failure as its error", async () => {
    sent.length = 0;
    const failure = Object.assign(new Error("expected 1 to be 2"), { name: "AssertionError" });

    await new TracedTest("books.test.ts > fails", ATTRS, processor, undefined).record(
      async () => {},
      () => [failure],
    );

    expect(sent.map((made) => [made.status, made.errors.map((error) => [error.type, error.message])])).toEqual([
      ["error", [["AssertionError", "expected 1 to be 2"]]],
    ]);
  });

  test("leaves out what completes while no test runs, and sends nothing without an agent", async () => {
    sent.length = 0;
    serve("/seed", () => query("INSERT INTO books (title) VALUES ($1)", ["Dune"]));
    await new Promise((done) => setTimeout(done, 60));

    expect(sent).toEqual([]);

    const quiet: Trace[] = [];
    const sink = new TestSink({ submit: (made) => quiet.push(made) }, false);
    const run = new TracedTest("books.test.ts > offline", ATTRS, processor, undefined);
    const previous = processor.sink;
    processor.sink = sink;
    try {
      await run.record(
        async () => query("SELECT 1", []),
        () => [],
      );
    } finally {
      processor.sink = previous;
    }

    expect(quiet).toEqual([]);
    expect(run.trace?.name).toBe("books.test.ts > offline");
  });

  test("maxQueries() fails a block that makes more, its requests' queries included", async () => {
    const run = new TracedTest("books.test.ts > counts", ATTRS, processor, undefined);
    const outcomes: unknown[] = [];

    await run.record(
      async () => {
        query("SELECT id FROM books", []);
        outcomes.push(
          await maxQueries(1, () => {
            serve("/books", () => query("SELECT 1", []));
            return "served";
          }),
        );
        outcomes.push(
          await maxQueries(1, () => {
            query("SELECT 2", []);
            serve("/authors", () => query("SELECT 3", []));
          }).catch((error: Error) => [error.name, error.message]),
        );
      },
      () => [],
    );

    expect(outcomes).toEqual(["served", ["AssertionError", "2 queries, at most 1 expected:\n  SELECT 2\n  SELECT 3"]]);
  });

  test("maxQueries() outside a test says what it needs", async () => {
    await expect(maxQueries(1, () => undefined)).rejects.toThrow(
      new UsageError(
        "maxQueries() counts the queries of a test's trace, and none is running: add tracepanel() to the plugins of the Vitest config",
      ),
    );
  });
});

group("the agent's console", () => {
  let server: Server;
  let url: string;
  const asked: string[] = [];
  let stored: Record<string, { summary: unknown; document: unknown }> = {};
  let storedAfter = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      asked.push(req.url ?? "");
      const address = new URL(req.url ?? "/", "http://console");
      const id = /^\/api\/traces\/(\w+)$/.exec(address.pathname)?.[1];
      res.setHeader("Content-Type", "application/json");
      if (id) {
        const found = stored[id];
        res.statusCode = found ? 200 : 404;
        res.end(JSON.stringify(found?.document ?? { error: "not found" }));
        return;
      }
      // The agent stores what it was sent in a thread of its own: a trace is listed a moment later.
      const ready = storedAfter-- <= 0;
      const ids = (address.searchParams.get("ids") ?? "").split(",");
      const traces = ready ? ids.flatMap((one) => (stored[one] ? [stored[one].summary] : [])) : [];
      res.end(JSON.stringify({ traces, next: null }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  });

  afterAll(() => new Promise((done) => server.close(done)));

  function traceOf(id: string, name: string, start: number, spans: Span[]): Trace {
    return {
      id,
      kind: "http",
      name,
      start,
      duration: 1,
      status: "ok",
      attrs: {},
      spans,
      logs: [],
      errors: [],
      links: [],
      issues: [],
    };
  }

  const sql: Span = {
    id: "S1",
    parent_id: "R1",
    kind: "sql",
    name: "SELECT authors",
    start: 0,
    duration: 0,
    status: "ok",
    attrs: { "db.statement": "SELECT name\n  FROM authors WHERE id = $1" },
  };

  test("lists what the agent found in the traces once it stored them, the oldest trace's first", async () => {
    asked.length = 0;
    storedAfter = 1;
    stored = {
      "01TEST000000000000000000AA": {
        summary: { id: "01TEST000000000000000000AA", issues: 1 },
        document: { issues: [{ kind: "error", title: "AssertionError: no", culprit: null, hint: null, span_ids: [] }] },
      },
      "01REQ0000000000000000000AA": {
        summary: { id: "01REQ0000000000000000000AA", issues: 1 },
        document: {
          issues: [
            {
              kind: "n+1",
              title: "N+1: 4 similar queries · SELECT authors",
              culprit: "src/books.ts:12 in list",
              hint: "Load the related rows with the parent rows.",
              count: 4,
              span_ids: ["gone", "S1"],
            },
          ],
        },
      },
      "01CLEAN00000000000000000AA": { summary: { id: "01CLEAN00000000000000000AA", issues: 0 }, document: {} },
    };
    const traces = [
      traceOf("01TEST000000000000000000AA", "books.test.ts > lists", 20, []),
      traceOf("01REQ0000000000000000000AA", "GET /books", 10, [sql]),
      traceOf("01CLEAN00000000000000000AA", "GET /health", 30, []),
    ];

    const found = await new Console(url).findings(traces);

    expect(found).toEqual([
      {
        kind: "n+1",
        title: "N+1: 4 similar queries · SELECT authors",
        culprit: "src/books.ts:12 in list",
        hint: "Load the related rows with the parent rows.",
        count: 4,
        query: "SELECT name FROM authors WHERE id = $1",
        traceId: "01REQ0000000000000000000AA",
        traceName: "GET /books",
        url: `${url.slice(0, -1)}/#/t/01REQ0000000000000000000AA`,
      },
      {
        kind: "error",
        title: "AssertionError: no",
        culprit: null,
        hint: null,
        count: 1,
        query: null,
        traceId: "01TEST000000000000000000AA",
        traceName: "books.test.ts > lists",
        url: `${url.slice(0, -1)}/#/t/01TEST000000000000000000AA`,
      },
    ]);

    const ids = "01TEST000000000000000000AA%2C01REQ0000000000000000000AA%2C01CLEAN00000000000000000AA";
    expect(asked).toEqual([
      `/api/traces?ids=${ids}&limit=3`,
      `/api/traces?ids=${ids}&limit=3`,
      "/api/traces/01REQ0000000000000000000AA",
      "/api/traces/01TEST000000000000000000AA",
    ]);
  });

  test("a test fails with the issues of the kinds it fails on, a link to its trace and how to allow them", async () => {
    storedAfter = 0;
    const run = new TracedTest("books.test.ts > lists", ATTRS, processor, new Console(url));
    run.trace = traceOf("01TEST000000000000000000AA", "books.test.ts > lists", 20, []);
    run.served.push(traceOf("01REQ0000000000000000000AA", "GET /books", 10, [sql]));
    const allowed = (kinds: string) => `Allowed here with { allow: [${kinds}] }.`;

    expect(await problems(run, { failOn: new Set(["n+1"]), maxQueries: 0 }, allowed)).toEqual([
      "1 queries, at most 0 expected:\n  SELECT name FROM authors WHERE id = $1",
      [
        "tracepanel found 1 issue in this test:",
        "",
        "N+1: 4 similar queries · SELECT authors",
        "  SELECT name FROM authors WHERE id = $1",
        "  at src/books.ts:12 in list",
        `  in GET /books → ${url.slice(0, -1)}/#/t/01REQ0000000000000000000AA`,
        "  Load the related rows with the parent rows.",
        "",
        `The test's trace: ${url.slice(0, -1)}/#/t/01TEST000000000000000000AA`,
        'Allowed here with { allow: ["n+1"] }.',
      ].join("\n"),
    ]);

    expect(await problems(run, { failOn: new Set(["duplicates"]), maxQueries: undefined }, allowed)).toEqual([]);
  });
});
