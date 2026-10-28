// Run by Bun itself after the build (`bun test/bun/queries.ts`, in CI's Bun job): Bun's stacks have no async frames,
// so a query Drizzle sends once the app awaits it has none of the app's code on its stack. The app's line is taken
// as the app calls Drizzle, through the plugin that hooks Drizzle's files as they load: each query is made on its own
// line, inside db.transaction() too, and names Drizzle. A query only library code made names that code, never
// Tracepanel's own, whose frames Bun maps back to its sources. The package as built: dist/, with its source maps.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { context, SpanKind, type Tracer, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { Config } from "../../src/config.js";
import type { Span, Trace } from "../../src/model.js";

/** A module of the build (dist/, which CI's Bun job builds first), typed as its source. */
async function built<T>(name: string): Promise<T> {
  return (await import(new URL(`../../dist/${name}.js`, import.meta.url).href)) as T;
}
const { loadConfig } = await built<typeof import("../../src/config.js")>("config");
const { TracepanelProcessor } = await built<typeof import("../../src/processor.js")>("processor");
const { traceBunQueries } = await built<typeof import("../../src/queries.js")>("queries");
const { wrapQuery } = await built<typeof import("../../src/transactions.js")>("transactions");

// The app, and the packages it uses: Drizzle (its database class, a query run as it is awaited), the driver, and a
// session store that queries on its own.
const root = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-bun-queries-")));
function write(path: string, lines: string[]): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), lines.join("\n"));
}
write("package.json", ['{ "name": "shop", "type": "module" }']);
write("node_modules/pg/package.json", ['{ "name": "pg", "type": "module" }']);
write("node_modules/pg/index.js", [
  "export class Client {",
  "  constructor(tracer) {",
  "    this.tracer = tracer;",
  "  }",
  "  async query(sql) {",
  '    const attributes = { "db.system": "postgresql", "db.statement": sql };',
  '    const span = this.tracer.startSpan("pg.query", { kind: 2, attributes });',
  "    await null;",
  "    span.end();",
  "    return { rows: [] };",
  "  }",
  "}",
]);
write("node_modules/drizzle-orm/package.json", ['{ "name": "drizzle-orm", "type": "module" }']);
write("node_modules/drizzle-orm/pg-core/db.js", [
  "class Query {",
  "  constructor(client, sql) {",
  "    this.client = client;",
  "    this.sql = sql;",
  "  }",
  "  then(resolve, reject) {",
  "    return Promise.resolve().then(() => this.client.query(this.sql)).then((result) => result.rows).then(resolve, reject);",
  "  }",
  "}",
  "class PgDatabase {",
  "  constructor(client) {",
  "    this.client = client;",
  "  }",
  "  select(table) {",
  "    return new Query(this.client, 'SELECT * FROM \"public\".\"' + table + '\"');",
  "  }",
  "  async transaction(run) {",
  "    await null;",
  '    await this.client.query("BEGIN");',
  "    const result = await run(new PgDatabase(this.client));",
  '    await this.client.query("COMMIT");',
  "    return result;",
  "  }",
  "}",
  "export { PgDatabase };",
]);
write("node_modules/session-store/package.json", ['{ "name": "session-store", "type": "module" }']);
write("node_modules/session-store/index.js", [
  "export function touch(client) {",
  '  return new Promise((done) => setTimeout(() => client.query("UPDATE session SET expires = now()").then(done), 0));',
  "}",
]);
write("app.js", [
  'import { touch } from "session-store";',
  "export async function listing(db) {",
  '  await db.select("category");',
  '  await db.select("brand");',
  "}",
  "export async function checkout(db) {",
  "  await db.transaction(async (tx) => {",
  '    await tx.select("product");',
  '    await tx.select("stock");',
  "  });",
  "}",
  "export async function session(client) {",
  "  await touch(client);",
  "}",
]);

const config: Config = { ...loadConfig({}), enabled: true, root, service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (made) => sent.push(made) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

// What `bun --preload @tracepanel/js/register` does before the app loads Drizzle.
traceBunQueries(root);
const { PgDatabase } = (await import(join(root, "node_modules/drizzle-orm/pg-core/db.js"))) as {
  PgDatabase: new (client: unknown) => unknown;
};
const { Client } = (await import(join(root, "node_modules/pg/index.js"))) as {
  Client: { new (tracer: Tracer): unknown; prototype: object };
};
wrapQuery(Client.prototype, "query", { client: "pg", system: "postgresql" });
const app = (await import(join(root, "app.js"))) as Record<string, (db: unknown) => Promise<void>>;

async function request(handler: () => Promise<void>): Promise<Trace> {
  const span = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/shop" },
  });
  await context.with(trace.setSpan(context.active(), span), handler);
  span.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

/** Each span: its kind, name and parent's name, and where it was made. */
function made(result: Trace): unknown[] {
  const byId = new Map(result.spans.map((span) => [span.id, span]));
  const parent = (span: Span) => (span.parent_id ? (byId.get(span.parent_id)?.name ?? "?") : null);
  return result.spans
    .filter((span) => span.kind !== "http")
    .map((span) => [
      span.kind,
      span.name,
      parent(span),
      span.attrs["db.client"],
      span.attrs["code.origin"],
      span.attrs["code.caller"],
    ]);
}

const listing = await request(() => app.listing?.(new PgDatabase(new Client(tracer))) ?? Promise.resolve());
assert.deepEqual(made(listing), [
  ["sql", "SELECT category", "GET /shop", "drizzle", "app.js:3 in listing", undefined],
  ["sql", "SELECT brand", "GET /shop", "drizzle", "app.js:4 in listing", undefined],
]);

const checkout = await request(() => app.checkout?.(new PgDatabase(new Client(tracer))) ?? Promise.resolve());
assert.deepEqual(made(checkout), [
  ["sql", "SELECT product", "transaction default", "drizzle", "app.js:8 in <anonymous>", undefined],
  ["sql", "SELECT stock", "transaction default", "drizzle", "app.js:9 in <anonymous>", undefined],
  ["transaction", "transaction default", "GET /shop", "drizzle", "app.js:7 in checkout", undefined],
]);

const session = await request(() => app.session?.(new Client(tracer)) ?? Promise.resolve());
const [update] = made(session) as unknown[][];
assert.deepEqual(update?.slice(0, 5), ["sql", "UPDATE session", "GET /shop", "pg", null]);
assert.match(String(update?.[5]), /^session-store\/index\.js:2 in /);

manager.disable();
// biome-ignore lint/suspicious/noConsole: the script's result, for CI's log
console.log("Bun queries made where the app called Drizzle");
