// SQLite's statements as steps, as the Python SDK records sqlite3's: better-sqlite3, Node's own node:sqlite and libsql
// (better-sqlite3's API). They run synchronously, in the app's call: a statement's span is the call, made where the
// app's line is on the stack. Each one keeps its SQL and the values it was run with (their hash tells a duplicate
// from an N+1), the database file's name, and the rows a read returned.
//
// The database each one ran on is remembered for the console's EXPLAIN QUERY PLAN, which runs on that same
// connection: it only plans, so it changes nothing, and an in-memory database can be explained too (explain.ts).
// better-sqlite3's db.transaction() is a transaction span (a savepoint inside another), as BEGIN … COMMIT is on any
// of them (transactions.ts).

import { basename } from "node:path";
import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from "@opentelemetry/instrumentation";
import { rememberSqlite } from "./explain.js";
import { commonJs, type Driver, statementIn, within } from "./transactions.js";

// biome-ignore lint/suspicious/noExplicitAny: the drivers' own types are the app's, not this package's.
type Any = any;

/** What a statement was prepared from: its SQL, and the connection and driver it runs on. */
interface Prepared {
  sql: string;
  db: Any;
  driver: Driver;
}

const PREPARED = new WeakMap<object, Prepared>();
/** A statement runs: the driver's own calls inside it (libsql's all() iterates) are part of it. */
let running = false;
const MARK = Symbol.for("tracepanel.sqlite");
const tracer = trace.getTracer("tracepanel-sqlite");

/** The methods that run a prepared statement, and how many rows each one's result is. */
const RUNS: Record<string, ((result: unknown) => number) | null> = {
  run: null,
  get: (row) => (row === undefined ? 0 : 1),
  all: (rows) => (Array.isArray(rows) ? rows.length : 0),
  // Rows as the app reads them: counted as they come, the span ends with the last.
  iterate: null,
};

const BETTER_SQLITE3: Driver = { client: "better-sqlite3", system: "sqlite" };
const NODE_SQLITE: Driver = { client: "node:sqlite", system: "sqlite" };
const LIBSQL: Driver = { client: "libsql", system: "sqlite" };

/** The database's file, as the span names it: its name only; none for one in memory. */
function fileOf(db: Any, driver: Driver): string | null {
  try {
    let path: unknown;
    if (driver === NODE_SQLITE) path = typeof db.location === "function" ? db.location() : null;
    else path = db.memory ? null : db.name;
    return typeof path === "string" && path !== "" && path !== ":memory:" ? basename(path) : null;
  } catch {
    return null;
  }
}

/** A value as JSON keeps it, to be bound again for EXPLAIN: a bigint as a number or text, bytes as nothing. */
function jsonable(value: unknown): unknown {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof DataView) return null;
  if (Array.isArray(value)) return value.map(jsonable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonable(item)]));
  }
  return value === undefined ? null : value;
}

/** A statement's span, under the app's current one; none outside a trace. */
function startSpan(sql: string, prepared: { db: Any; driver: Driver }, params?: unknown[]): Span | undefined {
  if (!trace.getActiveSpan()) return undefined;
  const file = fileOf(prepared.db, prepared.driver);
  try {
    rememberSqlite(prepared.db, file);
  } catch {
    // EXPLAIN is a convenience.
  }
  let values: string | undefined;
  try {
    values = params ? JSON.stringify(jsonable(params)) : undefined;
  } catch {
    values = undefined;
  }
  return tracer.startSpan("sqlite", {
    kind: SpanKind.CLIENT,
    attributes: {
      "db.system.name": "sqlite",
      "db.query.text": sql,
      "tracepanel.db.client": prepared.driver.client,
      ...(values !== undefined ? { "tracepanel.db.params": values } : {}),
      ...(file ? { "db.namespace": file } : {}),
    },
  });
}

function failed(span: Span | undefined, error: unknown): void {
  if (!span) return;
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
  span.end();
}

/** Runs a statement in its span; BEGIN, COMMIT and the like open and close the connection's transaction span. */
function traced<T>(
  sql: string,
  prepared: { db: Any; driver: Driver },
  params: unknown[] | undefined,
  call: () => T,
  rows: ((result: T) => number) | null,
): T {
  if (!trace.getActiveSpan()) return call();
  return statementIn(prepared.db, prepared.driver, sql, () => {
    const span = startSpan(sql, prepared, params);
    let result: T;
    running = true;
    try {
      result = call();
    } catch (error) {
      failed(span, error);
      throw error;
    } finally {
      running = false;
    }
    if (span && rows) span.setAttribute("db.response.returned_rows", rows(result));
    span?.end();
    return result;
  });
}

/** An iterator's rows, counted as the app reads them: the span ends with the last, or when the app stops. */
function counted(span: Span | undefined, iterator: Any): Any {
  if (!span || !iterator || typeof iterator.next !== "function") {
    span?.end();
    return iterator;
  }
  let count = 0;
  let open = true;
  const done = () => {
    if (!open) return;
    open = false;
    span.setAttribute("db.response.returned_rows", count);
    span.end();
  };
  const next = iterator.next.bind(iterator);
  const stop = typeof iterator.return === "function" ? iterator.return.bind(iterator) : undefined;
  iterator.next = (...args: unknown[]) => {
    try {
      const step = next(...args);
      if (step?.done) done();
      else count += 1;
      return step;
    } catch (error) {
      if (open) {
        open = false;
        failed(span, error);
      }
      throw error;
    }
  };
  iterator.return = (...args: unknown[]) => {
    done();
    return stop ? stop(...args) : { done: true, value: undefined };
  };
  return iterator;
}

/** Wraps run, get, all and iterate on a statement class, once. */
function wrapStatements(proto: Any): void {
  if (!proto || proto[MARK]) return;
  Object.defineProperty(proto, MARK, { value: true });
  for (const [method, rows] of Object.entries(RUNS)) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function (this: Any, ...params: unknown[]) {
      const prepared = PREPARED.get(this);
      if (!prepared || running || !trace.getActiveSpan()) return original.apply(this, params);
      if (method !== "iterate") return traced(prepared.sql, prepared, params, () => original.apply(this, params), rows);
      return statementIn(prepared.db, prepared.driver, prepared.sql, () => {
        const span = startSpan(prepared.sql, prepared, params);
        try {
          return counted(span, original.apply(this, params));
        } catch (error) {
          failed(span, error);
          throw error;
        }
      });
    };
  }
}

/** Wraps prepare (each statement remembers its SQL) and exec (a script, run as one step) on a database class. */
function wrapDatabase(proto: Any, driver: Driver): void {
  if (!proto || Object.hasOwn(proto, MARK)) return;
  Object.defineProperty(proto, MARK, { value: true });
  const prepare = proto.prepare;
  if (typeof prepare === "function") {
    proto.prepare = function (this: Any, ...args: unknown[]) {
      const statement = prepare.apply(this, args);
      try {
        if (statement && typeof args[0] === "string") {
          PREPARED.set(statement, { sql: args[0], db: this, driver });
          wrapStatements(Object.getPrototypeOf(statement));
        }
      } catch {
        // Never in the way of the app's statement.
      }
      return statement;
    };
  }
  const exec = proto.exec;
  if (typeof exec === "function") {
    proto.exec = function (this: Any, ...args: unknown[]) {
      const sql = args[0];
      if (typeof sql !== "string") return exec.apply(this, args);
      return traced(sql, { db: this, driver }, undefined, () => exec.apply(this, args), null);
    };
  }
}

/** better-sqlite3's db.transaction(fn): each of the function's modes runs fn in a transaction span. */
function wrapTransaction(proto: Any): void {
  const transaction = proto?.transaction;
  if (typeof transaction !== "function" || transaction[MARK]) return;
  const wrapped = function (this: Any, ...args: unknown[]) {
    const made = transaction.apply(this, args);
    const db = this;
    try {
      const modes = ["default", "deferred", "immediate", "exclusive"] as const;
      const traced = Object.fromEntries(
        modes.map((mode) => {
          const run = made[mode] ?? made;
          return [
            mode,
            function (this: unknown, ...params: unknown[]) {
              return within(db, BETTER_SQLITE3, () => run.apply(this, params));
            },
          ];
        }),
      );
      const properties = {
        ...Object.fromEntries(modes.map((mode) => [mode, { value: traced[mode] }])),
        database: { value: db, enumerable: true },
      };
      for (const mode of modes) Object.defineProperties(traced[mode], properties);
      return traced.default;
    } catch {
      return made;
    }
  };
  Object.defineProperty(wrapped, MARK, { value: true });
  proto.transaction = wrapped;
}

/** Nothing to undo: the wrappers stay, and do nothing once no span is active. */
const keep = (exports: Any) => exports;

/** Patches better-sqlite3's Database class: its statements, exec and db.transaction(). */
export function traceBetterSqlite3(Database: Any): void {
  wrapDatabase(Database?.prototype, BETTER_SQLITE3);
  wrapTransaction(Database?.prototype);
}

/** Patches libsql's Database class (better-sqlite3's API; its transactions run BEGIN and COMMIT through exec). */
export function traceLibsql(Database: Any): void {
  wrapDatabase(Database?.prototype, LIBSQL);
}

/** Patches node:sqlite's classes: Database and Statement (DatabaseSync and StatementSync before Node 25.7). */
export function traceNodeSqlite(exports: Any): Any {
  const sqlite = commonJs(exports) ?? exports;
  for (const name of ["Database", "DatabaseSync"]) wrapDatabase(sqlite?.[name]?.prototype, NODE_SQLITE);
  for (const name of ["Statement", "StatementSync"]) wrapStatements(sqlite?.[name]?.prototype);
  return exports;
}

export class SqliteInstrumentation extends InstrumentationBase {
  constructor() {
    super("tracepanel-sqlite", "1.0.0", {});
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition("better-sqlite3", [">=9"], keep, keep, [
        new InstrumentationNodeModuleFile(
          "better-sqlite3/lib/database.js",
          [">=9"],
          (exports: Any) => {
            traceBetterSqlite3(commonJs(exports));
            return exports;
          },
          keep,
        ),
      ]),
      new InstrumentationNodeModuleDefinition("libsql", [">=0.4"], (exports: Any) => {
        traceLibsql(commonJs(exports));
        return exports;
      }),
      new InstrumentationNodeModuleDefinition("node:sqlite", ["*"], traceNodeSqlite, keep),
    ];
  }
}
