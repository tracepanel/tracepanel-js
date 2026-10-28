// Transactions as the Python SDK records them: a `transaction` span from BEGIN (or START TRANSACTION) on a pg client,
// a mysql2 connection or a SQLite database (sqlite.ts) to its COMMIT or ROLLBACK, a nested `savepoint` span for each
// SAVEPOINT. What the app does
// meanwhile goes inside: the statements on that connection, and the calls it makes from where it began (an HTTP
// call, a job enqueued), which is what the agent's long-transaction and in-transaction issues look at.

import { type Context, context, type Span, SpanKind, trace } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from "@opentelemetry/instrumentation";

// biome-ignore lint/suspicious/noExplicitAny: the drivers' own types are the app's, not this package's.
type Any = any;

const BEGIN = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const COMMIT = /^\s*(COMMIT|END)\b/i;
const ROLLBACK = /^\s*(ROLLBACK|ABORT)\b/i;
const SAVEPOINT = /^\s*SAVEPOINT\b/i;
const RELEASE = /^\s*RELEASE\s+(SAVEPOINT\s+)?/i;
const ROLLBACK_TO = /^\s*ROLLBACK\s+(WORK\s+|TRANSACTION\s+)?TO\b/i;
/** Statements that only begin or end a transaction or a savepoint: the transaction span stands for them. */
export const CONTROL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/i;

const OPEN = Symbol.for("tracepanel.transactions");
const MARK = Symbol.for("tracepanel.transactions.wrapped");

interface Open {
  span: Span;
  /** The context the app was in as it began: what it is back in after the commit. */
  before: Context;
  /** The context with this span: the statements and calls made inside run in it. */
  inside: Context;
}

export interface Driver {
  client: string;
  system: string;
}

const tracer = trace.getTracer("tracepanel-transactions");

/**
 * The app's context from here on, as `await client.query("BEGIN")` returns: what the global context manager's
 * attach() does (AsyncLocalStorage's enterWith). A context manager without it leaves the app's context as it is.
 */
function enter(target: Context): void {
  const manager = (
    context as unknown as { _getContextManager?(): { attach?(ctx: Context): unknown } }
  )._getContextManager?.();
  manager?.attach?.(target);
}

function textOf(query: unknown): string {
  if (typeof query === "string") return query;
  if (query && typeof query === "object") {
    const { text, sql } = query as { text?: unknown; sql?: unknown };
    if (typeof text === "string") return text;
    if (typeof sql === "string") return sql;
  }
  return "";
}

function stack(connection: Any): Open[] {
  if (!connection[OPEN]) Object.defineProperty(connection, OPEN, { value: [], configurable: true });
  return connection[OPEN];
}

function open(connection: Any, driver: Driver, savepoint: boolean): Open | undefined {
  const opened = stack(connection);
  // Nothing to trace outside a request or a task; a second BEGIN on an open transaction begins nothing.
  if (!trace.getActiveSpan() || (!savepoint && opened.length > 0) || (savepoint && opened.length === 0)) {
    return undefined;
  }
  const before = context.active();
  const parent = savepoint ? (opened.at(-1)?.inside ?? before) : before;
  const span = tracer.startSpan(
    `${savepoint ? "savepoint" : "transaction"} default`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "tracepanel.span_kind": "transaction",
        "db.client": driver.client,
        "db.system": driver.system,
        "db.vendor": driver.system,
        "db.alias": "default",
        "db.transaction.savepoint": savepoint,
      },
    },
    parent,
  );
  const entry = { span, before, inside: trace.setSpan(parent, span) };
  opened.push(entry);
  enter(entry.inside);
  return entry;
}

/** The innermost savepoint, or everything still open, ends: the app is back where it began. */
function close(connection: Any, outcome: "commit" | "rollback", savepointOnly: boolean): Open[] {
  const opened: Open[] = connection?.[OPEN] ?? [];
  const closed: Open[] = [];
  while (opened.length > 0) {
    const entry = opened.pop() as Open;
    entry.span.setAttribute("db.transaction.outcome", outcome);
    closed.push(entry);
    if (savepointOnly) break;
  }
  const outermost = closed.at(-1);
  if (outermost && trace.getSpan(context.active()) === closed[0]?.span) enter(outermost.before);
  return closed;
}

function end(entries: Open[]): void {
  for (const entry of entries) entry.span.end();
}

/** Ends the spans once a statement without a callback is done: its promise, or its `end` event. */
function after(result: Any, done: () => void): void {
  if (result && typeof result.then === "function") {
    result.then(done, done);
  } else if (result && typeof result.once === "function") {
    result.once("end", done);
    result.once("error", done);
  } else {
    done();
  }
}

/**
 * Where a statement runs, by its text: BEGIN or SAVEPOINT opens a span and runs in it, any other in the connection's
 * innermost transaction; COMMIT, ROLLBACK and RELEASE close what they end (`ending`, to end once it ran).
 */
function place(connection: Any, driver: Driver, text: string): { run: Context | undefined; ending: Open[] } {
  let ending: Open[] = [];
  let run: Context | undefined;
  try {
    if (BEGIN.test(text)) {
      run = open(connection, driver, false)?.inside;
    } else if (SAVEPOINT.test(text)) {
      run = open(connection, driver, true)?.inside;
    } else {
      // The statement runs inside the connection's innermost transaction, whichever context it came from.
      run = (connection?.[OPEN] as Open[] | undefined)?.at(-1)?.inside;
      if (ROLLBACK_TO.test(text) || RELEASE.test(text)) {
        ending = close(connection, ROLLBACK_TO.test(text) ? "rollback" : "commit", true);
      } else if (COMMIT.test(text) || ROLLBACK.test(text)) {
        ending = close(connection, COMMIT.test(text) ? "commit" : "rollback", false);
      }
    }
  } catch {
    // Never in the way of the app's query.
  }
  return { run, ending };
}

/**
 * A statement a driver runs in the app's call (SQLite's): in the connection's transaction, which BEGIN opens and
 * COMMIT or ROLLBACK ends as it returns.
 */
export function statementIn<T>(connection: Any, driver: Driver, text: string, call: () => T): T {
  const { run, ending } = place(connection, driver, text);
  try {
    return run ? context.with(run, call) : call();
  } finally {
    end(ending);
  }
}

/**
 * A function the driver runs in a transaction of its own making (better-sqlite3's db.transaction()): a transaction
 * span around it, a savepoint inside another one; committed unless it throws.
 */
export function within<T>(connection: Any, driver: Driver, call: () => T): T {
  const entry = open(connection, driver, stack(connection).length > 0);
  if (!entry) return call();
  let outcome: "commit" | "rollback" = "rollback";
  try {
    const result = context.with(entry.inside, call);
    outcome = "commit";
    return result;
  } finally {
    // Only this one: the transaction it is in goes on.
    end(close(connection, outcome, true));
  }
}

/** Whether a wrapper is calling the statement through: the ones it calls in turn pass it on. */
let calling = false;

/** Wraps `query` (and mysql2's `execute`) on a connection prototype. */
export function wrapQuery(proto: Any, method: string, driver: Driver): void {
  const original = proto?.[method];
  if (typeof original !== "function" || original[MARK]) return;
  const wrapped = function (this: Any, ...args: unknown[]) {
    // Another of these wrappers further in (the module hooked twice) leaves the statement to this one.
    if (calling) return original.apply(this, args);
    const { run, ending } = place(this, driver, textOf(args[0]));
    const call = () => {
      calling = true;
      try {
        return original.apply(this, args);
      } finally {
        calling = false;
      }
    };
    if (ending.length === 0) return run ? context.with(run, call) : call();
    const callbackAt = args.findIndex((arg) => typeof arg === "function");
    const done = () => end(ending);
    if (callbackAt >= 0) {
      const callback = args[callbackAt] as (...results: unknown[]) => unknown;
      args[callbackAt] = function (this: unknown, ...results: unknown[]) {
        done();
        return callback.apply(this, results);
      };
    }
    const result = run ? context.with(run, call) : call();
    if (callbackAt < 0) after(result, done);
    return result;
  };
  Object.defineProperty(wrapped, MARK, { value: true });
  proto[method] = wrapped;
}

/** A connection back in its pool with a transaction still open: the transaction is over for the app. */
export function wrapRelease(proto: Any, method: string, connectionOf: (self: Any, args: unknown[]) => Any): void {
  const original = proto?.[method];
  if (typeof original !== "function" || original[MARK]) return;
  const wrapped = function (this: Any, ...args: unknown[]) {
    try {
      end(close(connectionOf(this, args), "rollback", false));
    } catch {
      // Never in the way of the app's release.
    }
    return original.apply(this, args);
  };
  Object.defineProperty(wrapped, MARK, { value: true });
  proto[method] = wrapped;
}

/** A CommonJS module's exports, also when an ES module loader hands over its namespace. */
export function commonJs(exports: Any): Any {
  return exports?.[Symbol.toStringTag] === "Module" ? exports.default : exports;
}

/** Nothing to undo: the wrappers stay, and do nothing once no span is active. */
const keep = (exports: Any) => exports;

const PG = { client: "pg", system: "postgresql" };
const MYSQL = { client: "mysql2", system: "mysql" };

export class TransactionsInstrumentation extends InstrumentationBase {
  constructor() {
    super("tracepanel-transactions", "1.0.0", {});
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        "pg",
        [">=8"],
        (exports: Any) => {
          wrapQuery(commonJs(exports).Client?.prototype, "query", PG);
          return exports;
        },
        keep,
        [
          // pg imported by its ES module's file URL (Nitro's dev server) loads without the hook above: its client
          // class is wrapped as it loads, once the module's other hooks (OpenTelemetry's, which wrap it too) are done.
          new InstrumentationNodeModuleFile(
            "pg/lib/client.js",
            [">=8"],
            (exports: Any) => {
              const proto = commonJs(exports)?.prototype;
              queueMicrotask(() => wrapQuery(proto, "query", PG));
              return exports;
            },
            keep,
          ),
        ],
      ),
      new InstrumentationNodeModuleDefinition("pg-pool", [">=3"], (exports: Any) => {
        wrapRelease(commonJs(exports)?.prototype, "_release", (_pool, args) => args[0]);
        return exports;
      }),
      new InstrumentationNodeModuleDefinition("mysql2", [">=3"], (exports: Any) => exports, undefined, [
        new InstrumentationNodeModuleFile(
          "mysql2/lib/connection.js",
          [">=3"],
          (exports: Any) => {
            // mysql2 3.11.5 moved query and execute to a base class.
            const proto = exports?.prototype;
            const base = proto && !Object.hasOwn(proto, "query") ? Object.getPrototypeOf(proto) : proto;
            wrapQuery(base, "query", MYSQL);
            wrapQuery(base, "execute", MYSQL);
            return exports;
          },
          keep,
        ),
        new InstrumentationNodeModuleFile(
          "mysql2/lib/pool_connection.js",
          [">=3"],
          (exports: Any) => {
            wrapRelease(exports?.prototype, "release", (connection) => connection);
            return exports;
          },
          keep,
        ),
      ]),
    ];
  }
}
