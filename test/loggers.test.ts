import { Writable } from "node:stream";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import winston from "winston";
import { type Config, loadConfig } from "../src/config.js";
import { captureConsole } from "../src/console.js";
import { patchPino, patchWinston } from "../src/loggers.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (trace) => sent.push(trace) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

patchPino(pino, processor);
patchWinston(winston, processor);

async function request(handler: () => void): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/orders" },
  });
  context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

/** Where the app's logger writes, kept to check it still gets every line. */
function lines(): { stream: Writable; written: string[] } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      done();
    },
  });
  return { stream, written };
}

const time = expect.any(Number);
const stack = (message: string) => expect.stringMatching(new RegExp(`^Error: ${message}\\n\\s+at `));

describe("pino", () => {
  it("records each call in the request's trace: level, message, the logger's name, fields and error", async () => {
    const { stream, written } = lines();
    const logger = pino({ name: "orders", level: "info" }, stream);

    const result = await request(() => {
      logger.info({ orderId: 42, password: "hunter2", items: [{ sku: "a" }] }, "placed %s", "order");
      logger.child({ module: "billing" }).error(new Error("declined"), "charge failed");
      logger.warn({ err: new Error("slow") });
      logger.fatal("down");
      logger.debug("below the logger's level");
    });

    expect(result.logs).toEqual([
      {
        span_id: expect.any(String),
        time,
        level: "info",
        logger: "orders",
        message: "placed order",
        exception: null,
        attrs: { "extra.orderid": 42, "extra.password": "********", "extra.items": "[ { sku: 'a' } ]" },
      },
      {
        span_id: expect.any(String),
        time,
        level: "error",
        logger: "orders",
        message: "charge failed",
        exception: stack("declined"),
        attrs: { "extra.module": "billing" },
      },
      {
        span_id: expect.any(String),
        time,
        level: "warning",
        logger: "orders",
        message: "slow",
        exception: stack("slow"),
        attrs: {},
      },
      {
        span_id: expect.any(String),
        time,
        level: "critical",
        logger: "orders",
        message: "down",
        exception: null,
        attrs: {},
      },
    ]);

    expect(written.map((line) => JSON.parse(line).msg)).toEqual(["placed order", "charge failed", "slow", "down"]);
  });

  it("names the logger pino when it has no name, and records nothing outside a trace", async () => {
    const { stream, written } = lines();
    const logger = pino(stream);

    logger.info("starting");
    const result = await request(() => logger.info("handled"));

    expect(result.logs.map(({ logger, message }) => [logger, message])).toEqual([["pino", "handled"]]);

    expect(written).toHaveLength(2);
  });
});

describe("winston", () => {
  it("records each call in the request's trace: level, message, fields and error", async () => {
    const { stream, written } = lines();
    const logger = winston.createLogger({
      level: "info",
      defaultMeta: { service: "shop" },
      format: winston.format.combine(winston.format.splat(), winston.format.json()),
      transports: [new winston.transports.Stream({ stream })],
    });

    const result = await request(() => {
      logger.info("placed", { orderId: 42, token: "abc" });
      logger.child({ module: "billing" }).error("charge failed", new Error("declined"));
      logger.error(new Error("broken"));
      logger.warn("slow %s after %dms", "checkout", 900, { attempt: 2 });
      logger.log({ level: "http", message: "GET /orders" });
      logger.debug("below the logger's level");
    });

    expect(result.logs).toEqual([
      {
        span_id: expect.any(String),
        time,
        level: "info",
        logger: "winston",
        message: "placed",
        exception: null,
        attrs: { "extra.service": "shop", "extra.orderid": 42, "extra.token": "********" },
      },
      {
        span_id: expect.any(String),
        time,
        level: "error",
        logger: "winston",
        message: "charge failed declined",
        exception: stack("declined"),
        attrs: { "extra.service": "shop", "extra.module": "billing" },
      },
      {
        span_id: expect.any(String),
        time,
        level: "error",
        logger: "winston",
        message: "broken",
        exception: stack("broken"),
        attrs: { "extra.service": "shop" },
      },
      {
        span_id: expect.any(String),
        time,
        level: "warning",
        logger: "winston",
        message: "slow checkout after 900ms",
        exception: null,
        attrs: { "extra.service": "shop", "extra.attempt": 2 },
      },
    ]);

    expect(written).toHaveLength(4);
  });

  it("records what the Console transport prints through console once", async () => {
    captureConsole(processor);
    const printed: unknown[] = [];
    // biome-ignore lint/suspicious/noConsole: the terminal's console.log, put back after the test.
    const original = console.log;
    console.log = (...args: unknown[]) => printed.push(args);
    try {
      const logger = winston.createLogger({
        format: winston.format.simple(),
        transports: [new winston.transports.Console({ forceConsole: true })],
      });

      const result = await request(() => logger.info("handled"));

      expect(result.logs.map(({ logger, message }) => [logger, message])).toEqual([["winston", "handled"]]);

      expect(printed).toEqual([["info: handled"]]);
    } finally {
      console.log = original;
    }
  });
});
