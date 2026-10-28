// A query made through an ORM names it in db.client, as the Python SDK names Django and SQLAlchemy: the agent's N+1
// hint is the ORM's own way to load the related rows. The ORM is the package its frames are in, between the app's
// code and the driver's.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { context, SpanKind, type Tracer, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { wrapQuery } from "../src/transactions.js";
import { underLibrary } from "./app/shop.js";

const APP = new URL("./app/", import.meta.url).pathname.slice(0, -1);
const config: Config = { ...loadConfig({}), enabled: true, root: APP, service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (made) => sent.push(made) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
// The transaction spans' tracer is the global one.
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

const SQL = 'SELECT "name" FROM "author" WHERE "id" = $1';

// The drivers, and the ORMs on them, as installed packages: each ORM's code calls its driver, which starts the span.
const modules = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-orm-")));
function install(path: string, lines: string[]): void {
  mkdirSync(dirname(join(modules, "node_modules", path)), { recursive: true });
  writeFileSync(join(modules, "node_modules", path), lines.join("\n"));
}
install("pg/index.js", [
  "exports.query = (tracer, sql) => {",
  '  tracer.startSpan("pg.query:SELECT", { kind: 2, attributes: { "db.system": "postgresql", "db.statement": sql } }).end();',
  "};",
]);
install("mongodb/index.js", [
  "exports.find = (tracer) => {",
  '  const attributes = { "db.system": "mongodb", "db.operation": "find", "db.mongodb.collection": "users" };',
  '  tracer.startSpan("mongodb.find", { kind: 2, attributes }).end();',
  "};",
]);
// pg's pool runs a query once it has a connection, from a callback: its stack has neither the app's frames nor the
// ORM's, only the checkout before it has.
install("pg-pool/index.js", [
  'const pg = require("pg");',
  "exports.query = (tracer, sql) => {",
  '  tracer.startSpan("pg-pool.connect", { kind: 0 }).end();',
  "  setTimeout(() => pg.query(tracer, sql), 0);",
  "};",
]);
install("drizzle-orm/node-postgres/driver.js", [
  'const pool = require("pg-pool");',
  "class NodePgSession {",
  "  execute(tracer, sql) {",
  "    pool.query(tracer, sql);",
  "  }",
  "}",
  "module.exports = NodePgSession;",
]);
// Prisma ORM 7 runs its SQL through a driver adapter, @prisma/adapter-pg; Drizzle calls node-postgres itself.
install("@prisma/adapter-pg/index.js", [
  'const pg = require("pg");',
  "class PrismaPgAdapter {",
  "  queryRaw(tracer, sql) {",
  "    pg.query(tracer, sql);",
  "  }",
  "}",
  "module.exports = PrismaPgAdapter;",
]);
install("drizzle-orm/node-postgres/session.js", [
  'const pg = require("pg");',
  "class NodePgPreparedQuery {",
  "  execute(tracer, sql) {",
  "    pg.query(tracer, sql);",
  "  }",
  "}",
  "module.exports = NodePgPreparedQuery;",
]);
// The adapter begins an interactive transaction ($transaction(async (tx) => ...)) on a client of its pool.
install("pg/client.js", [
  "class Client {",
  "  constructor(tracer) {",
  "    this.tracer = tracer;",
  "  }",
  "  query(sql) {",
  '    const attributes = { "db.system": "postgresql", "db.statement": sql };',
  '    this.tracer.startSpan("pg.query", { kind: 2, attributes }).end();',
  "    return Promise.resolve();",
  "  }",
  "}",
  "module.exports = Client;",
]);
install("@prisma/adapter-pg/transaction.js", [
  'const Client = require("pg/client.js");',
  "exports.startTransaction = async (tracer) => {",
  "  const client = new Client(tracer);",
  '  await client.query("BEGIN");',
  "  return client;",
  "};",
]);
install("mongoose/lib/query.js", [
  'const mongodb = require("mongodb");',
  "class Query {",
  "  exec(tracer) {",
  "    mongodb.find(tracer);",
  "  }",
  "}",
  "module.exports = Query;",
]);
const load = createRequire(join(modules, "package.json"));
const pg = load("pg") as { query(tracer: Tracer, sql: string): void };
const PrismaPgAdapter = load("@prisma/adapter-pg") as new () => { queryRaw(tracer: Tracer, sql: string): void };
const NodePgPreparedQuery = load("drizzle-orm/node-postgres/session.js") as new () => {
  execute(tracer: Tracer, sql: string): void;
};
const NodePgSession = load("drizzle-orm/node-postgres/driver.js") as new () => {
  execute(tracer: Tracer, sql: string): void;
};
const Client = load("pg/client.js") as { prototype: object };
wrapQuery(Client.prototype, "query", { client: "pg", system: "postgresql" });
const prismaTransaction = load("@prisma/adapter-pg/transaction.js") as {
  startTransaction(tracer: Tracer): Promise<{ query(sql: string): Promise<void> }>;
};
const Query = load("mongoose/lib/query.js") as new () => { exec(tracer: Tracer): void };

async function request(handler: () => Promise<void> | void): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/posts" },
  });
  await context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

function call(made: Trace): Record<string, unknown> | undefined {
  return made.spans.find((span) => span.kind === "sql" || span.kind === "mongodb")?.attrs;
}

const ORIGIN = expect.stringMatching(/^shop\.ts:\d+ in underLibrary$/);

function statement(client: string): Record<string, unknown> {
  return {
    "db.client": client,
    "db.system": "postgresql",
    "db.vendor": "postgresql",
    "db.alias": "default",
    "db.statement": SQL,
    "db.fingerprint": SQL,
    "db.params_hash": null,
    "db.many": false,
    "code.origin": ORIGIN,
  };
}

describe("db.client", () => {
  it("is prisma for a query Prisma's driver adapter made", async () => {
    const made = await request(() => underLibrary(() => new PrismaPgAdapter().queryRaw(tracer, SQL)));

    expect(call(made)).toEqual(statement("prisma"));
  });

  it("is drizzle for a query Drizzle made", async () => {
    const made = await request(() => underLibrary(() => new NodePgPreparedQuery().execute(tracer, SQL)));

    expect(call(made)).toEqual(statement("drizzle"));
  });

  it("is drizzle for a query Drizzle made through a pool, run from the pool's callback", async () => {
    const made = await request(() => underLibrary(() => new NodePgSession().execute(tracer, SQL)));

    expect(call(made)).toEqual(statement("drizzle"));
  });

  it("is the driver for a query the app made with the driver", async () => {
    const made = await request(() => underLibrary(() => pg.query(tracer, SQL)));

    expect(call(made)).toEqual(statement("pg"));
  });

  it("is mongoose for a MongoDB command Mongoose made", async () => {
    const made = await request(() => underLibrary(() => new Query().exec(tracer)));

    expect(call(made)).toEqual({
      "db.client": "mongoose",
      "db.system": "mongodb",
      "db.operation": "find",
      "db.namespace": null,
      "db.collection.name": "users",
      "db.statement": "",
      "db.params_hash": null,
      "server.address": null,
      "server.port": null,
      "code.origin": ORIGIN,
    });
  });

  it("is prisma for a transaction Prisma's driver adapter began", async () => {
    const made = await request(async () => {
      const client = await underLibrary(() => prismaTransaction.startTransaction(tracer));
      await client.query("COMMIT");
    });

    expect(made.spans.find((span) => span.kind === "transaction")?.attrs).toEqual({
      "db.client": "prisma",
      "db.system": "postgresql",
      "db.vendor": "postgresql",
      "db.alias": "default",
      "db.transaction.savepoint": false,
      "db.transaction.outcome": "commit",
      "code.origin": ORIGIN,
    });
  });
});
