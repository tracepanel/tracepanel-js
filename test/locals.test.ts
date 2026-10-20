// An error's frames carry their local variables, as the Python SDK records them: the app's own frames, each value as
// text, a secret's masked. Read through the inspector as the error is thrown, inside a trace only.
import { readFileSync } from "node:fs";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { repr, variables } from "../src/locals.js";
import type { Frame, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { placeOrder, placeOrderLater } from "./app/shop.js";

// The project is test/app: its code is the app's, this file stands for the framework.
const APP = new URL("./app/", import.meta.url);
const root = APP.pathname.slice(0, -1);
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);

afterAll(() => manager.disable());

/** `shop.ts:<line>`: the line of the app with this comment. */
function line(comment: string): number {
  const lines = readFileSync(new URL("shop.ts", APP), "utf8").split("\n");
  return lines.findIndex((text) => text.includes(`// ${comment}`)) + 1;
}

/** A processor of its own, with these settings, and the traces it sends. */
function app(env: Record<string, string> = {}) {
  const config: Config = { ...loadConfig(env), enabled: true, root, service: "shop" };
  const sent: Trace[] = [];
  const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
  const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("test");

  /** A request whose handler runs `handler`: what it throws, the framework catches and records on its span. */
  async function request(handler: () => unknown): Promise<Trace> {
    const span = tracer.startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "GET", "url.path": "/orders" },
    });
    await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        await handler();
      } catch (error) {
        span.recordException(error as Error);
      }
    });
    span.setAttribute("http.response.status_code", 500);
    span.end();
    await new Promise((done) => setTimeout(done, 60));
    return sent.at(-1) as Trace;
  }

  return { request };
}

/** The app's frames of the trace's error, innermost last: function, line, locals. */
function own(result: Trace): [string, number, Frame["locals"]][] {
  return (result.errors[0]?.frames ?? [])
    .filter((frame) => frame.in_app)
    .map((frame) => [frame.function, frame.lineno, frame.locals]);
}

describe("an error's local variables", () => {
  it("are read in each of the app's frames, a secret masked, a long value cut", async () => {
    const result = await app().request(() => placeOrder(["book", "pen"]));

    expect(own(result)).toEqual([
      ["placeOrder", line("ordered"), { items: "[ 'book', 'pen' ]", total: "20" }],
      [
        "chargeCard",
        line("declined"),
        {
          customer: "{ id: 7, name: 'Ann' }",
          password: "********",
          attempts: "3",
          note: `'${"x".repeat(160)}'... 140 more characters`,
        },
      ],
    ]);

    expect(result.errors[0]?.frames.filter((frame) => !frame.in_app).every((frame) => frame.locals === null)).toBe(
      true,
    );
  });

  it("are read where the error is thrown: a caller waiting on an await has none", async () => {
    const result = await app().request(() => placeOrderLater(["book"]));

    expect(own(result)).toEqual([
      ["placeOrderLater", line("awaited"), null],
      ["chargeLater", line("later"), { customer: "{ id: 7, name: 'Ann' }", password: "********" }],
      ["chargeCard", line("declined"), expect.objectContaining({ password: "********", attempts: "3" })],
    ]);
  });

  it("are read anew when another trace throws the same error, from the same lines", async () => {
    const { request } = app();
    /** The order placed, its error swallowed by the app or not. */
    const attempt = (items: string[], swallow: boolean) =>
      request(() => {
        try {
          placeOrder(items);
        } catch (error) {
          if (!swallow) throw error;
        }
      });
    await attempt(["book", "pen"], true);
    const result = await attempt(["book", "pen", "cup"], false);

    expect(own(result)[0]).toEqual(["placeOrder", line("ordered"), { items: "[ 'book', 'pen', 'cup' ]", total: "30" }]);
  });

  it("are not read with TRACEPANEL_CAPTURE_LOCALS=0", async () => {
    const result = await app({ TRACEPANEL_CAPTURE_LOCALS: "0" }).request(() => placeOrder(["book"]));

    expect(own(result).map(([, , locals]) => locals)).toEqual([null, null]);
  });

  it("are not read outside a trace", async () => {
    const { request } = app();
    await request(() => {});
    let thrown: Error | undefined;
    try {
      placeOrder(["book"]);
    } catch (error) {
      thrown = error as Error;
    }
    // The same error, recorded in a trace after all: nothing was read as it was thrown.
    const result = await request(() => {
      throw thrown;
    });

    expect(own(result).map(([, , locals]) => locals)).toEqual([null, null]);
  });
});

describe("a value as text", () => {
  it("is inspect()'s, cut short, masked under a sensitive name", () => {
    expect([
      repr("count", 3),
      repr("name", "Ann"),
      repr(
        "rows",
        Array.from({ length: 12 }, (_, at) => at),
      ),
      repr("deep", { a: { b: { c: { d: 1 } } } }),
      repr("api_key", "k-123"),
      repr("sessionToken", { id: 1 }),
      repr("huge", Object.fromEntries(Array.from({ length: 200 }, (_, at) => [`key${at}`, at]))).length,
    ]).toEqual([
      "3",
      "'Ann'",
      "[ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, ... 2 more items ]",
      "{ a: { b: { c: [Object] } } }",
      "********",
      "********",
      1000,
    ]);

    // Anything else, a request or a connection, is cut as Python's reprlib cuts a repr(): 160 characters.
    class Connection {
      host = "db";
      buffer = "x".repeat(400);
    }
    const connection = repr("connection", new Connection());
    expect([connection.length, connection.slice(0, 25), connection.slice(-3)]).toEqual([
      160,
      "Connection { host: 'db', ",
      "...",
    ]);
  });

  it("a frame's variables: the innermost scope first, at most 40", () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, at) => [`v${at}`, at]));

    expect(
      variables([
        { id: 2, row: "inner" },
        { id: 1, total: 3, __proto_like: 1, ".generator_object": {} },
      ]),
    ).toEqual({ id: "2", row: "'inner'", total: "3" });

    expect(Object.keys(variables([many])).length).toBe(40);
  });
});
