// pg on a real Postgres: the console's EXPLAIN runs there and rolls back, and BEGIN … COMMIT on a client is a
// transaction span with its statements inside. It runs when TRACEPANEL_TEST_POSTGRES names a Postgres
// (postgres://shop:secret@127.0.0.1:5432/shop).
import { createRequire } from "node:module";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { DatabasesInstrumentation, explain } from "../src/explain.js";
import type { Span, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { TransactionsInstrumentation } from "../src/transactions.js";

const POSTGRES = process.env.TRACEPANEL_TEST_POSTGRES;

type Client = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const pg = createRequire(import.meta.url)("pg") as { Client: new (url: string) => Client };

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (made) => sent.push(made) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
const tracer = provider.getTracer("test");
let client: Client | undefined;

beforeAll(async () => {
  if (!POSTGRES) return;
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
  // As setup.ts orders them: pg's statements, then the transactions around them, then the databases for EXPLAIN.
  for (const instrumentation of [
    new PgInstrumentation({ enhancedDatabaseReporting: true }),
    new TransactionsInstrumentation(),
    new DatabasesInstrumentation(),
  ]) {
    instrumentation.setTracerProvider(provider);
    const [definition] = [instrumentation.getModuleDefinitions()].flat();
    definition?.patch?.(pg, "8.23.1");
  }
  client = new pg.Client(POSTGRES);
  await client.connect();
  await client.query("DROP TABLE IF EXISTS tracepanel_books");
  await client.query("CREATE TABLE tracepanel_books (id serial PRIMARY KEY, title text NOT NULL)");
});

afterAll(async () => {
  await client?.query("DROP TABLE IF EXISTS tracepanel_books");
  await client?.end();
  manager.disable();
});

async function request(handler: () => Promise<void>): Promise<Trace> {
  const root = tracer.startSpan("POST", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "POST", "url.path": "/books" },
  });
  await context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

function shape(result: Trace): unknown[] {
  const byId = new Map(result.spans.map((span) => [span.id, span]));
  const parent = (span: Span) => (span.parent_id ? (byId.get(span.parent_id)?.name ?? "?") : null);
  return result.spans.map((span) => [span.kind, span.name, parent(span)]);
}

test.skipIf(!POSTGRES)("BEGIN … COMMIT on a real client is a transaction span with its statements inside", async () => {
  const result = await request(async () => {
    await client?.query("BEGIN");
    await client?.query("INSERT INTO tracepanel_books (title) VALUES ($1)", ["Dune"]);
    await client?.query("COMMIT");
    await client?.query("SELECT count(*) FROM tracepanel_books");
  });

  expect(shape(result)).toEqual([
    ["sql", "INSERT tracepanel_books", "transaction default"],
    ["transaction", "transaction default", "POST /books"],
    ["sql", "SELECT COUNT tracepanel_books", "POST /books"],
    ["http", "POST /books", null],
  ]);

  expect(result.spans.find((span) => span.kind === "transaction")?.attrs).toEqual({
    "db.client": "pg",
    "db.system": "postgresql",
    "db.vendor": "postgresql",
    "db.alias": "default",
    "db.transaction.savepoint": false,
    "db.transaction.outcome": "commit",
    "code.origin": null,
    "code.caller": expect.stringMatching(/\/test\/postgres-live\.test\.ts:\d+ in /),
  });
});

test.skipIf(!POSTGRES)("the console's EXPLAIN runs on the app's database and rolls back what it ran", async () => {
  const url = new URL(POSTGRES ?? "postgres://localhost");

  const answer = await explain({
    sql: "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, BUFFERS OFF) DELETE FROM tracepanel_books",
    params: [],
    vendor: "postgresql",
    server: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
  });

  expect(answer).toEqual({
    columns: ["QUERY PLAN"],
    rows: [
      ["Delete on tracepanel_books (actual rows=0.00 loops=1)"],
      ["  ->  Seq Scan on tracepanel_books (actual rows=1.00 loops=1)"],
    ],
  });

  // ANALYZE ran the DELETE, inside the transaction EXPLAIN rolled back.
  expect((await client?.query("SELECT title FROM tracepanel_books"))?.rows).toEqual([{ title: "Dune" }]);
});
