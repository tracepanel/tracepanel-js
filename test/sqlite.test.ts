// SQLite's statements as steps: better-sqlite3, node:sqlite and libsql, their transactions, and EXPLAIN QUERY PLAN on
// the app's own connection.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import BetterSqlite3 from "better-sqlite3";
import Libsql from "libsql";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { explain } from "../src/explain.js";
import type { Span, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { traceBetterSqlite3, traceLibsql, traceNodeSqlite } from "../src/sqlite.js";
import { type Db, listProducts, placeOrder, pricesOneByOne } from "./app/catalog.js";

// The project is test/app: its code is the app's, this file stands for the framework.
const root = new URL("./app/", import.meta.url).pathname.slice(0, -1);
const config: Config = { ...loadConfig({}), enabled: true, root, service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

traceBetterSqlite3(BetterSqlite3);
traceLibsql(Libsql);
// Node's own, from 22.13 without a flag; not on Node 20.
const nodeSqlite = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as
  | { DatabaseSync: new (path: string) => Db }
  | undefined;
if (nodeSqlite) traceNodeSqlite(nodeSqlite);

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const dir = mkdtempSync(join(tmpdir(), "tracepanel-sqlite-"));

/** A shop's database: products 1 to 3, and orders. */
function shop<T extends Db>(db: T): T {
  db.exec(`
    CREATE TABLE product (id INTEGER PRIMARY KEY, name TEXT, price REAL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL);
    INSERT INTO product (name, price) VALUES ('tea', 3.5), ('cake', 4), ('jam', 6);
  `);
  return db;
}

async function request(handler: () => void): Promise<Trace> {
  const span = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/shop" },
  });
  context.with(trace.setSpan(context.active(), span), handler);
  span.end();
  await pause(60);
  return sent.at(-1) as Trace;
}

const statements = (result: Trace): Span[] => result.spans.filter((span) => span.kind === "sql");

function shape(result: Trace): unknown[] {
  const byId = new Map(result.spans.map((span) => [span.id, span]));
  const parent = (span: Span) => (span.parent_id ? (byId.get(span.parent_id)?.name ?? "?") : null);
  return result.spans.map((span) => [span.kind, span.name, parent(span)]);
}

describe("better-sqlite3", () => {
  it("records each statement with its SQL, values, file, rows and the app's line", async () => {
    const db = shop(new BetterSqlite3(join(dir, "shop.db")));
    const result = await request(() => pricesOneByOne(db, [1, 2, 2]));

    expect(statements(result).map((span) => [span.name, span.attrs])).toEqual([
      [
        "SELECT product",
        {
          "db.params": [1],
          "db.client": "better-sqlite3",
          "db.system": "sqlite",
          "db.vendor": "sqlite",
          "db.alias": "default",
          "db.namespace": "shop.db",
          "db.response.returned_rows": 1,
          "db.statement": "SELECT price FROM product WHERE id = ?",
          "db.fingerprint": "SELECT price FROM product WHERE id = ?",
          "db.params_hash": expect.stringMatching(/^[0-9a-f]{12}$/),
          "db.many": false,
          "code.origin": expect.stringMatching(/^catalog\.ts:\d+ in <anonymous>$/),
        },
      ],
      ["SELECT product", expect.objectContaining({ "db.params": [2] })],
      ["SELECT product", expect.objectContaining({ "db.params": [2] })],
    ]);

    // The same values twice are a duplicate, other values the same statement again: an N+1.
    const [one, two, again] = statements(result).map((span) => span.attrs["db.params_hash"]);
    expect([one === two, two === again]).toEqual([false, true]);
    db.close();
  });

  it("counts the rows all() returned and iterate() gave, and runs exec() as one step", async () => {
    const db = shop(new BetterSqlite3(":memory:"));
    const result = await request(() => listProducts(db));

    expect(
      statements(result).map((span) => [span.attrs["db.statement"], span.attrs["db.response.returned_rows"]]),
    ).toEqual([
      ["SELECT * FROM product", 3],
      ["SELECT id FROM product WHERE price > :min", 3],
    ]);
    // Named values as the app passed them; no file for a database in memory.
    expect(statements(result)[1]?.attrs).toEqual(
      expect.objectContaining({ "db.params": [{ min: 0 }], "db.client": "better-sqlite3" }),
    );
    expect(statements(result)[1]?.attrs["db.namespace"]).toBeUndefined();

    const script = await request(() => db.exec("UPDATE product SET price = price + 1"));
    expect(
      statements(script).map((span) => [span.name, span.attrs["db.params"], span.attrs["db.params_hash"]]),
    ).toEqual([["UPDATE product", undefined, null]]);
    db.close();
  });

  it("makes db.transaction() a transaction span, a savepoint inside another, rolled back when it throws", async () => {
    const db = shop(new BetterSqlite3(":memory:"));
    const add = db.prepare("INSERT INTO orders (total) VALUES (?)");
    const inner = db.transaction((total: number) => add.run(total));
    const failing = db.transaction(() => {
      add.run(1);
      throw new Error("out of stock");
    });
    const outer = db.transaction(() => {
      inner(10);
      try {
        failing();
      } catch {
        // The app goes on.
      }
    });
    const result = await request(() => outer.immediate());

    expect(shape(result)).toEqual([
      ["sql", "INSERT orders", "savepoint default"],
      ["transaction", "savepoint default", "transaction default"],
      ["sql", "INSERT orders", "savepoint default"],
      ["transaction", "savepoint default", "transaction default"],
      ["transaction", "transaction default", "GET /shop"],
      ["http", "GET /shop", null],
    ]);
    expect(
      result.spans.filter((span) => span.kind === "transaction").map((span) => span.attrs["db.transaction.outcome"]),
    ).toEqual(["commit", "rollback", "commit"]);
    expect(result.spans.find((span) => span.name === "transaction default")?.attrs).toEqual({
      "db.client": "better-sqlite3",
      "db.system": "sqlite",
      "db.vendor": "sqlite",
      "db.alias": "default",
      "db.transaction.savepoint": false,
      "db.transaction.outcome": "commit",
      "code.origin": null,
      "code.caller": expect.stringMatching(/\/test\/sqlite\.test\.ts:\d+ in /),
    });
    expect(db.prepare("SELECT total FROM orders").all()).toEqual([{ total: 10 }]);
    db.close();
  });

  it("makes BEGIN … COMMIT the app runs a transaction span, its statements inside", async () => {
    const db = shop(new BetterSqlite3(":memory:"));
    const result = await request(() => placeOrder(db, 12));

    expect(shape(result)).toEqual([
      ["sql", "INSERT orders", "transaction default"],
      ["transaction", "transaction default", "GET /shop"],
      ["http", "GET /shop", null],
    ]);
    db.close();
  });

  it("records a statement that fails as an error, and nothing outside a trace", async () => {
    const db = shop(new BetterSqlite3(":memory:"));
    const result = await request(() => {
      try {
        db.prepare("SELECT * FROM product WHERE id = ?").get("x", "y");
      } catch {
        // The app handles it.
      }
    });

    expect(statements(result).map((span) => [span.name, span.status])).toEqual([["SELECT product", "error"]]);
    expect(result.errors.map((error) => [error.type, error.message])).toEqual([
      ["RangeError", "Too many parameter values were provided"],
    ]);

    const before = sent.length;
    expect(pricesOneByOne(db, [1])).toEqual([{ price: 3.5 }]);
    await pause(60);
    expect(sent.length).toBe(before);
    db.close();
  });
});

describe.runIf(nodeSqlite)("node:sqlite", () => {
  it("records its statements and transactions as better-sqlite3's", async () => {
    const Database = nodeSqlite?.DatabaseSync as new (path: string) => Db & { close(): void };
    const db = shop(new Database(join(dir, "node.db")));
    const result = await request(() => {
      pricesOneByOne(db, [3]);
      placeOrder(db, 5);
    });

    expect(shape(result)).toEqual([
      ["sql", "SELECT product", "GET /shop"],
      ["sql", "INSERT orders", "transaction default"],
      ["transaction", "transaction default", "GET /shop"],
      ["http", "GET /shop", null],
    ]);
    expect(statements(result)[0]?.attrs).toEqual({
      "db.params": [3],
      "db.client": "node:sqlite",
      "db.system": "sqlite",
      "db.vendor": "sqlite",
      "db.alias": "default",
      "db.namespace": "node.db",
      "db.response.returned_rows": 1,
      "db.statement": "SELECT price FROM product WHERE id = ?",
      "db.fingerprint": "SELECT price FROM product WHERE id = ?",
      "db.params_hash": expect.stringMatching(/^[0-9a-f]{12}$/),
      "db.many": false,
      "code.origin": expect.stringMatching(/^catalog\.ts:\d+ in <anonymous>$/),
    });
    db.close();
  });
});

describe("libsql", () => {
  it("records its statements, and BEGIN … COMMIT its db.transaction() runs", async () => {
    const db = shop(
      new Libsql(":memory:") as unknown as Db & { close(): void; transaction(fn: () => void): () => void },
    );
    const result = await request(() => {
      pricesOneByOne(db, [1]);
      listProducts(db);
      db.transaction(() => db.prepare("INSERT INTO orders (total) VALUES (?)").run(7))();
    });

    // Its all() iterates: one step, not two.
    expect(shape(result)).toEqual([
      ["sql", "SELECT product", "GET /shop"],
      ["sql", "SELECT product", "GET /shop"],
      ["sql", "SELECT product", "GET /shop"],
      ["sql", "INSERT orders", "transaction default"],
      ["transaction", "transaction default", "GET /shop"],
      ["http", "GET /shop", null],
    ]);
    expect(statements(result)[0]?.attrs).toEqual(
      expect.objectContaining({ "db.client": "libsql", "db.params": [1], "db.response.returned_rows": 1 }),
    );
    db.close();
  });
});

describe("EXPLAIN QUERY PLAN", () => {
  it("runs on the connection that ran the query, by its file, with the values the agent sends back", async () => {
    const db = shop(new BetterSqlite3(join(dir, "plans.db")));
    await request(() => pricesOneByOne(db, [1]));
    const other = shop(new BetterSqlite3(join(dir, "other.db")));
    await request(() => pricesOneByOne(other, [1]));
    other.exec("DROP TABLE product");

    const plan = await explain({
      sql: "EXPLAIN QUERY PLAN SELECT price FROM product WHERE id = ?",
      params: [1],
      vendor: "sqlite",
      server: null,
      port: null,
      database: "plans.db",
    });

    expect(plan).toEqual({
      columns: ["id", "parent", "notused", "detail"],
      rows: [[expect.any(Number), 0, expect.any(Number), "SEARCH product USING INTEGER PRIMARY KEY (rowid=?)"]],
    });

    const scan = await explain({
      sql: "EXPLAIN QUERY PLAN SELECT * FROM product WHERE name = :name",
      params: [{ name: "tea" }],
      vendor: "sqlite",
      database: "plans.db",
    });
    expect(scan.rows.map((row) => row[3])).toEqual(["SCAN product"]);
    db.close();
    other.close();
  });

  it("explains a database in memory, inside the app's open transaction too", async () => {
    const db = shop(new BetterSqlite3(":memory:"));
    await request(() => pricesOneByOne(db, [2]));
    db.exec("BEGIN");

    const plan = await explain({
      sql: "EXPLAIN QUERY PLAN SELECT price FROM product WHERE id = ?",
      params: [2],
      vendor: "sqlite",
      database: null,
    });

    expect(plan.rows.map((row) => row[3])).toEqual(["SEARCH product USING INTEGER PRIMARY KEY (rowid=?)"]);
    expect(db.inTransaction).toBe(true);
    db.exec("ROLLBACK");
    db.close();
    await expect(
      explain({ sql: "EXPLAIN QUERY PLAN SELECT 1", params: [], vendor: "sqlite", database: null }),
    ).rejects.toThrow("The app's SQLite connection is closed.");
  });
});
