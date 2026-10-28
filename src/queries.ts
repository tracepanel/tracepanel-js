// Where an ORM's query was made, when the driver's stack can't say. Bun's (JavaScriptCore's) stacks have no async
// frames: `await db.select().from(product)` runs Drizzle's then() from a microtask, and the driver's span starts under
// Drizzle's frames alone, none of the app's. The app's line is taken here instead, as the app calls the ORM (the
// query's first builder call, db.transaction(), db.query's findMany()), and handed to the driver's span in the app's
// context from then on, with the ORM's name: the span takes it when its own stack has none of the app's code.

import { readFileSync } from "node:fs";
import { type Context, context, createContextKey, trace } from "@opentelemetry/api";
import { madeAt } from "./stack.js";

/** The app's line of the latest ORM call in this context, and the ORM: what a query span without one takes. */
export const QUERY_ORIGIN = createContextKey("tracepanel.query_origin");

export interface QueryOrigin {
  origin: string;
  orm: string;
}

/**
 * The app's context from here on, as `await client.query("BEGIN")` returns: what the global context manager's
 * attach() does (AsyncLocalStorage's enterWith). A context manager without it leaves the app's context as it is.
 */
export function enter(target: Context): void {
  const manager = (
    context as unknown as { _getContextManager?(): { attach?(ctx: Context): unknown } }
  )._getContextManager?.();
  manager?.attach?.(target);
}

const WRAPPED = Symbol.for("tracepanel.queries");

/** Wraps the methods of an ORM class's prototype the app calls to start a query: each one takes the app's line. */
export function markQueries(proto: object | undefined, orm: string, root: string): void {
  if (!proto || (proto as { [WRAPPED]?: boolean })[WRAPPED]) return;
  Object.defineProperty(proto, WRAPPED, { value: true });
  for (const name of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const original = descriptor?.value;
    if (name === "constructor" || typeof original !== "function") continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      if (trace.getActiveSpan()) {
        try {
          const { origin } = madeAt(root);
          if (origin) enter(context.active().setValue(QUERY_ORIGIN, { origin, orm } satisfies QueryOrigin));
        } catch {
          // Never in the way of the app's query.
        }
      }
      return original.apply(this, args);
    };
    Object.defineProperty(proto, name, { ...descriptor, value: wrapped });
  }
}

// Drizzle's classes the app calls to start a query, by the file each is in: a dialect's database (PgDatabase,
// MySqlDatabase, BaseSQLiteDatabase: db and tx) and its relational query builder (db.query.product.findMany()).
const DRIZZLE = /[\\/]drizzle-orm[\\/][\w-]+-core[\\/](db|query-builders[\\/]query)\.c?js$/;
const DATABASE = /^class (\w+Database) /m;

const HOOK = Symbol.for("tracepanel.queries.drizzle");

/**
 * Drizzle's entry points on Bun. Its ES modules load without the hooks Node has (import-in-the-middle): a Bun
 * plugin adds a line to each file as it loads, which hands its class over to be wrapped. A file that has changed and
 * no longer has the class is left as it is.
 */
export function traceBunQueries(root: string): void {
  const bun = (globalThis as { Bun?: BunPlugins }).Bun;
  if (!bun?.plugin) return;
  (globalThis as { [HOOK]?: (proto: object | undefined) => void })[HOOK] = (proto) =>
    markQueries(proto, "drizzle", root);
  bun.plugin({
    name: "tracepanel-queries",
    setup(build) {
      build.onLoad({ filter: DRIZZLE }, (args) => {
        const source = readFileSync(args.path, "utf8");
        const name = DRIZZLE.exec(args.path)?.[1] === "db" ? DATABASE.exec(source)?.[1] : "RelationalQueryBuilder";
        const hook = name
          ? `\n;typeof ${name} === "function" && globalThis[Symbol.for("tracepanel.queries.drizzle")]?.(${name}.prototype);\n`
          : "";
        return { contents: source + hook, loader: "js" };
      });
    },
  });
}

interface BunPlugins {
  plugin(plugin: {
    name: string;
    setup(build: {
      onLoad(
        options: { filter: RegExp },
        callback: (args: { path: string }) => { contents: string; loader: "js" },
      ): void;
    }): void;
  }): void;
}
