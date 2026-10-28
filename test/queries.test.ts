// Bun's stacks have no async frames: a query an ORM sends after the app's `await` has none of the app's code on its
// stack. The app's line is taken as the app calls the ORM (queries.ts) and the driver's span takes it, with the ORM.
// Here the driver runs from a pool's callback, as pg-pool's does, so no stack it starts under has the app's frames
// or the ORM's, on Node too.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { context, SpanKind, type Tracer, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { Span, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { markQueries } from "../src/queries.js";
import { twoQueries, underLibrary } from "./app/shop.js";

const APP = new URL("./app/", import.meta.url);
const config: Config = { ...loadConfig({}), enabled: true, root: APP.pathname.slice(0, -1), service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (made) => sent.push(made) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

/** `shop.ts:<line> in <function>`: the line of the app with this comment. */
function line(comment: string, fn: string): string {
  const lines = readFileSync(new URL("shop.ts", APP), "utf8").split("\n");
  return `shop.ts:${lines.findIndex((text) => text.includes(`// ${comment}`)) + 1} in ${fn}`;
}

// The driver, the pool that runs its queries from a callback, and an ORM whose query runs once it is awaited.
const modules = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-queries-")));
function install(path: string, lines: string[]): void {
  mkdirSync(dirname(join(modules, "node_modules", path)), { recursive: true });
  writeFileSync(join(modules, "node_modules", path), lines.join("\n"));
}
install("pg/index.js", [
  "exports.query = (tracer, sql) => {",
  '  tracer.startSpan("pg.query:SELECT", { kind: 2, attributes: { "db.system": "postgresql", "db.statement": sql } }).end();',
  "};",
]);
install("pg-pool/index.js", [
  'const pg = require("pg");',
  "exports.query = (tracer, sql, done) => {",
  "  setTimeout(() => {",
  "    pg.query(tracer, sql);",
  "    done();",
  "  }, 0);",
  "};",
]);
install("drizzle-orm/pg-core/db.js", [
  'const pool = require("pg-pool");',
  "class PgDatabase {",
  "  select(tracer, sql) {",
  "    return { then: (resolve) => pool.query(tracer, sql, () => resolve([])) };",
  "  }",
  "}",
  "module.exports = PgDatabase;",
]);
const PgDatabase = createRequire(join(modules, "package.json"))("drizzle-orm/pg-core/db.js") as new () => {
  select(tracer: Tracer, sql: string): PromiseLike<unknown[]>;
};
markQueries(PgDatabase.prototype, "drizzle", config.root);
const db = new PgDatabase();

async function request(handler: () => Promise<void>): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/products" },
  });
  await context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

function queries(made: Trace): Span[] {
  return made.spans.filter((span) => span.kind === "sql");
}

const CATEGORY = 'SELECT "name" FROM "public"."category" WHERE "id" = $1';
const BRAND = 'SELECT "name" FROM "public"."brand" WHERE "id" = $1';

describe("a query an ORM sends after the app's await", () => {
  it("is made where the app called the ORM, and names it", async () => {
    const made = await request(async () => {
      await underLibrary(() => db.select(tracer, CATEGORY));
    });

    expect(queries(made).map((span) => [span.name, span.attrs])).toEqual([
      [
        "SELECT category",
        {
          "db.client": "drizzle",
          "db.system": "postgresql",
          "db.vendor": "postgresql",
          "db.alias": "default",
          "db.statement": CATEGORY,
          "db.fingerprint": CATEGORY,
          "db.params_hash": null,
          "db.many": false,
          "code.origin": line("library", "underLibrary"),
        },
      ],
    ]);
  });

  it("is made on its own line, not the one of the query before it", async () => {
    const made = await request(() =>
      twoQueries(
        () => db.select(tracer, CATEGORY),
        () => db.select(tracer, BRAND),
      ),
    );

    expect(queries(made).map((span) => [span.name, span.attrs["db.client"], span.attrs["code.origin"]])).toEqual([
      ["SELECT category", "drizzle", line("first query", "twoQueries")],
      ["SELECT brand", "drizzle", line("second query", "twoQueries")],
    ]);
  });

  it("takes nothing outside a request: the ORM's call is the app's as it is", async () => {
    expect(await db.select(tracer, CATEGORY)).toEqual([]);
  });
});
