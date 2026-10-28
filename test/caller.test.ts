// A query none of the app's code made (a session store's, before any handler runs): its span names the library code
// that asked for it (code.caller) past the driver, as the Python SDK records it; one the app made names only the app.
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
import { madeAt } from "../src/stack.js";
import { underLibrary } from "./app/shop.js";

// The project is test/app; the libraries are installed packages: a driver, and a session store on it.
const APP = new URL("./app/", import.meta.url).pathname.slice(0, -1);
const config: Config = { ...loadConfig({}), enabled: true, root: APP, service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (made) => sent.push(made) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

const modules = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-caller-")));
function install(path: string, lines: string[]): void {
  mkdirSync(dirname(join(modules, "node_modules", path)), { recursive: true });
  writeFileSync(join(modules, "node_modules", path), lines.join("\n"));
}
install("pg/index.js", [
  "exports.query = (tracer, sql) => {",
  '  tracer.startSpan("pg.query:SELECT", { kind: 2, attributes: { "db.system": "postgresql", "db.statement": sql } }).end();',
  "};",
]);
install("connect-pg-simple/index.js", [
  'const pg = require("pg");',
  "class PGStore {",
  "  get(tracer) {",
  '    pg.query(tracer, "SELECT sess FROM session WHERE sid = $1");',
  "  }",
  "}",
  "module.exports = PGStore;",
]);
const load = createRequire(join(modules, "package.json"));
const pg = load("pg") as { query(tracer: Tracer, sql: string): void };
const PGStore = load("connect-pg-simple") as new () => { get(tracer: Tracer): void };

async function request(handler: () => Promise<void> | void): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/account" },
  });
  await context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

function query(made: Trace): Record<string, unknown> {
  const span = made.spans.find((candidate) => candidate.kind === "sql");
  return Object.fromEntries(Object.entries(span?.attrs ?? {}).filter(([name]) => name.startsWith("code.")));
}

describe("code.caller", () => {
  it("names the library code that asked for a query no code of the app's made, past the driver", async () => {
    const made = await request(() => new PGStore().get(tracer));

    expect(query(made)).toEqual({
      "code.origin": null,
      "code.caller": "connect-pg-simple/index.js:4 in PGStore.get",
    });
  });

  it("is left out of a query the app made, through the same library", async () => {
    const made = await request(() => underLibrary(() => new PGStore().get(tracer)));

    expect(query(made)).toEqual({ "code.origin": expect.stringMatching(/^shop\.ts:\d+ in underLibrary$/) });
  });

  it("is left out when only the driver was on the stack", async () => {
    // A timer calls the driver itself: no frame but its own and Node's.
    const made = await request(
      () =>
        new Promise<void>((done) => {
          setTimeout(pg.query, 0, tracer, "SELECT 1");
          setTimeout(done, 5);
        }),
    );

    expect(query(made)).toEqual({ "code.origin": null });
  });

  it("is the first frame outside the project when that is not a package: a script elsewhere", () => {
    expect(madeAt(APP)).toEqual({
      origin: null,
      caller: expect.stringMatching(/\/test\/caller\.test\.ts:\d+ in /),
      orm: null,
    });
  });
});
