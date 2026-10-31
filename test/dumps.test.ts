// A developer's own debug output as dumps the call tree always shows, as the Python SDK records devtools' debug():
// console.dir(), console.table(), console.log() of an object; each argument's source text, text, type and length.
// biome-ignore-all lint/suspicious/noConsole: the terminal's console methods, swapped and put back.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: source text with template literals in it.
import { readFileSync } from "node:fs";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { captureConsole } from "../src/console.js";
import { argumentsAt, MAX_REPR } from "../src/dumps.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { dirAndTable, inspectOrder, longValue, plainLine, withSecret } from "./app/debug.js";

// The project is test/app: its code is the app's, this file stands for the framework.
const APP = new URL("./app/", import.meta.url);
const root = APP.pathname.slice(0, -1);
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);

afterAll(() => manager.disable());

/** `debug.ts:<line> in <function>`: the line of the app with this comment. */
function origin(comment: string, fn: string): string {
  const lines = readFileSync(new URL("debug.ts", APP), "utf8").split("\n");
  return `debug.ts:${lines.findIndex((text) => text.includes(`// ${comment}`)) + 1} in ${fn}`;
}

/** What the terminal got: each console call's method and arguments. */
let printed: [string, unknown[]][] = [];
const originals: Record<string, unknown> = {};
const METHODS = ["log", "info", "debug", "dir", "table"] as const;

beforeEach(() => {
  printed = [];
  for (const method of METHODS) {
    originals[method] = console[method];
    console[method] = (...args: unknown[]) => printed.push([method, args]);
  }
});

afterEach(() => {
  for (const method of METHODS) (console as unknown as Record<string, unknown>)[method] = originals[method];
});

/** A processor of its own, with these settings, capturing console; and a request that runs a handler. */
function app(env: Record<string, string> = {}) {
  const config: Config = { ...loadConfig(env), enabled: true, root, service: "shop" };
  const sent: Trace[] = [];
  const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
  const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("test");
  captureConsole(processor, config);

  async function request(handler: () => void): Promise<Trace> {
    const span = tracer.startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "GET", "url.path": "/orders" },
    });
    context.with(trace.setSpan(context.active(), span), handler);
    span.end();
    await new Promise((done) => setTimeout(done, 60));
    return sent.at(-1) as Trace;
  }

  return { request, sent };
}

/** A trace's logs without their time and span. */
function logs(result: Trace) {
  return result.logs.map(({ time: _time, span_id: _span, ...log }) => log);
}

describe("dumps", () => {
  it("records console.log() of an object as a dump, each argument with its source text", async () => {
    const result = await app().request(inspectOrder);

    expect(logs(result)).toEqual([
      {
        level: "debug",
        logger: "console",
        message: "{ id: 7, items: [ 'book', 'pen' ] } 2",
        exception: null,
        attrs: {
          "log.kind": "dump",
          "dump.lang": "javascript",
          "dump.args": [
            {
              expr: "order",
              repr: "{\n  id: 7,\n  items: [\n    'book',\n    'pen'\n  ]\n}",
              type: "Object",
              len: null,
            },
            { expr: "order.items.length", repr: "2", type: "number", len: null },
          ],
          "code.origin": origin("log", "inspectOrder"),
        },
      },
    ]);
    expect(result.logs[0]?.span_id).toBe(result.spans[0]?.id);

    expect(printed).toEqual([["log", [{ id: 7, items: ["book", "pen"] }, 2]]]);
  });

  it("records console.dir() and console.table() of their first argument", async () => {
    const result = await app().request(dirAndTable);

    expect(logs(result)).toEqual([
      {
        level: "debug",
        logger: "console",
        message: "{ id: 7, items: [Array] }",
        exception: null,
        attrs: {
          "log.kind": "dump",
          "dump.lang": "javascript",
          "dump.args": [
            {
              expr: "order",
              repr: "{\n  id: 7,\n  items: [\n    'book',\n    'pen'\n  ]\n}",
              type: "Object",
              len: null,
            },
          ],
          "code.origin": origin("dir", "dirAndTable"),
        },
      },
      {
        level: "debug",
        logger: "console",
        message: [
          "┌─────────┬────────┬─────┐",
          "│ (index) │ sku    │ qty │",
          "├─────────┼────────┼─────┤",
          "│ 0       │ 'book' │ 1   │",
          "└─────────┴────────┴─────┘",
        ].join("\n"),
        exception: null,
        attrs: {
          "log.kind": "dump",
          "dump.lang": "javascript",
          "dump.args": [
            {
              expr: '[{ sku: "book", qty: 1 }]',
              repr: "[\n  {\n    sku: 'book',\n    qty: 1\n  }\n]",
              type: "Array",
              len: 1,
            },
          ],
          "code.origin": origin("table", "dirAndTable"),
        },
      },
    ]);

    expect(printed.map(([method]) => method)).toEqual(["dir", "table"]);
  });

  it("leaves a log line of primitives only as it was", async () => {
    const result = await app().request(plainLine);

    expect(logs(result)).toEqual([
      { level: "info", logger: "console", message: "order 7 placed", exception: null, attrs: {} },
    ]);
  });

  it("masks an argument whose source names a secret; a string literal has no source text", async () => {
    const result = await app().request(withSecret);

    expect(logs(result)).toEqual([
      {
        level: "debug",
        logger: "console",
        message: "user: { name: 'ann' } ********",
        exception: null,
        attrs: {
          "log.kind": "dump",
          "dump.lang": "javascript",
          "dump.args": [
            { expr: null, repr: "'user:'", type: "string", len: 5 },
            { expr: "user", repr: "{\n  name: 'ann'\n}", type: "Object", len: null },
            { expr: "apiToken", repr: "********", type: "string", len: null },
          ],
          "code.origin": origin("secret", "withSecret"),
        },
      },
    ]);

    expect(printed).toEqual([["log", ["user:", { name: "ann" }, "s3cr3t"]]]);
  });

  it("cuts a long value, and reads a call over several lines", async () => {
    const result = await app().request(longValue);
    const args = result.logs[0]?.attrs["dump.args"] as { expr: string; repr: string; type: string; len: number }[];

    expect(args.map(({ expr, type, len }) => ({ expr, type, len }))).toEqual([
      { expr: "big", type: "Map", len: 1 },
      { expr: '[1, 2, 3].map((n) => ({ n, label: `n=${n}, (${"a,b"})` }))', type: "Array", len: 3 },
    ]);

    expect(args[0]?.repr).toHaveLength(MAX_REPR);
    expect(args[0]?.repr.endsWith("… (truncated)")).toBe(true);
    expect(result.logs[0]?.attrs["code.origin"]).toBe(origin("info", "longValue"));
  });

  it("records nothing outside a trace, and console prints as before", async () => {
    const { sent } = app();

    inspectOrder();

    expect(sent).toEqual([]);

    expect(printed).toEqual([["log", [{ id: 7, items: ["book", "pen"] }, 2]]]);
  });

  it("with TRACEPANEL_DUMPS=0, console.log() of an object is a log line as before, console.dir() nothing", async () => {
    const result = await app({ TRACEPANEL_DUMPS: "0" }).request(() => {
      inspectOrder();
      dirAndTable();
    });

    expect(logs(result)).toEqual([
      {
        level: "info",
        logger: "console",
        message: "{ id: 7, items: [ 'book', 'pen' ] } 2",
        exception: null,
        attrs: {},
      },
    ]);

    expect(printed.map(([method]) => method)).toEqual(["log", "dir", "table"]);
  });
});

describe("a call's arguments as source text", () => {
  const at = (text: string) => argumentsAt(text, text.indexOf("("));

  it("splits at the call's own commas only", () => {
    expect(at('log(a, f(b, c), [d, e], { f: 1, g }, "h, i", `j ${k(", ")} l`)')).toEqual([
      "a",
      "f(b, c)",
      "[d, e]",
      "{ f: 1, g }",
      '"h, i"',
      '`j ${k(", ")} l`',
    ]);

    expect(at("log(a, /* b, c */ d,)")).toEqual(["a", "d"]);

    expect(at("log(\n  a, // first\n  b.c(\n    d,\n  ),\n)")).toEqual(["a", "b.c( d, )"]);

    expect(at("log()")).toEqual([]);
  });

  it("gives up on a call it can't read", () => {
    expect(at("log(a, (b")).toBeNull();

    expect(at("log(a, ']')")).toEqual(["a", "']'"]);

    expect(at("log(a, 'b)")).toBeNull();
  });
});
