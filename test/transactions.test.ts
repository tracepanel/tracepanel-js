import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { Span, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { wrapQuery, wrapRelease } from "../src/transactions.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (trace) => sent.push(trace) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A pg client as OpenTelemetry's pg instrumentation leaves it: each query a span in the caller's context, its
 * statement set once the span has started.
 */
class Client {
  async query(text: string): Promise<{ rows: unknown[] }> {
    const span = tracer.startSpan(`pg.query:${text.split(" ")[0]}`, {
      kind: SpanKind.CLIENT,
      attributes: { "db.system.name": "postgresql" },
    });
    span.setAttribute("db.query.text", text);
    await pause(2);
    span.end();
    return { rows: [] };
  }
}
wrapQuery(Client.prototype, "query", { client: "pg", system: "postgresql" });

/** pg-pool's release: the client goes back with whatever it had open. */
class Pool {
  _release(_client: Client): void {}
}
wrapRelease(Pool.prototype, "_release", (_pool, args) => args[0]);

/** A call to another service, as the undici instrumentation records fetch(). */
async function fetchSomething(): Promise<void> {
  const span = tracer.startSpan("GET", {
    kind: SpanKind.CLIENT,
    attributes: { "http.request.method": "GET", "url.full": "http://127.0.0.1:8062/charge" },
  });
  await pause(2);
  span.end();
}

async function request(handler: () => Promise<void>): Promise<Trace> {
  const root = tracer.startSpan("POST", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "POST", "url.path": "/checkout" },
  });
  await context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await pause(60);
  return sent.at(-1) as Trace;
}

function shape(result: Trace): unknown[] {
  const byId = new Map(result.spans.map((span) => [span.id, span]));
  const parent = (span: Span) => (span.parent_id ? (byId.get(span.parent_id)?.name ?? "?") : null);
  return result.spans.map((span) => [span.kind, span.name, parent(span)]);
}

describe("transactions", () => {
  it("makes BEGIN … COMMIT on a client a transaction span, with the work in between inside it", async () => {
    const result = await request(async () => {
      const client = new Client();
      await client.query("BEGIN");
      await client.query("INSERT INTO orders (total) VALUES ($1)");
      await fetchSomething();
      await client.query("COMMIT");
      await client.query("SELECT 1");
    });

    expect(shape(result)).toEqual([
      ["sql", "INSERT orders", "transaction default"],
      ["http.client", "GET 127.0.0.1/charge", "transaction default"],
      ["transaction", "transaction default", "POST /checkout"],
      ["sql", "SELECT", "POST /checkout"],
      ["http", "POST /checkout", null],
    ]);

    const transaction = result.spans.find((span) => span.kind === "transaction");
    expect(transaction?.attrs).toEqual({
      "db.client": "pg",
      "db.system": "postgresql",
      "db.vendor": "postgresql",
      "db.alias": "default",
      "db.transaction.savepoint": false,
      "db.transaction.outcome": "commit",
      "code.origin": null,
    });
  });

  it("nests a savepoint and ends both on ROLLBACK", async () => {
    const result = await request(async () => {
      const client = new Client();
      await client.query("BEGIN");
      await client.query("SAVEPOINT items");
      await client.query("UPDATE product SET stock = 0");
      await client.query("ROLLBACK TO SAVEPOINT items");
      await client.query("ROLLBACK");
    });

    expect(shape(result)).toEqual([
      ["sql", "UPDATE product", "savepoint default"],
      ["transaction", "savepoint default", "transaction default"],
      ["transaction", "transaction default", "POST /checkout"],
      ["http", "POST /checkout", null],
    ]);

    expect(result.spans.filter((span) => span.kind === "transaction").map((span) => span.attrs)).toEqual([
      expect.objectContaining({ "db.transaction.savepoint": true, "db.transaction.outcome": "rollback" }),
      expect.objectContaining({ "db.transaction.savepoint": false, "db.transaction.outcome": "rollback" }),
    ]);
  });

  it("ends a transaction the app released without COMMIT", async () => {
    const result = await request(async () => {
      const client = new Client();
      await client.query("BEGIN");
      new Pool()._release(client);
      await fetchSomething();
    });

    expect(shape(result)).toEqual([
      ["transaction", "transaction default", "POST /checkout"],
      ["http.client", "GET 127.0.0.1/charge", "POST /checkout"],
      ["http", "POST /checkout", null],
    ]);

    const transaction = result.spans.find((span) => span.kind === "transaction");
    expect(transaction?.attrs["db.transaction.outcome"]).toBe("rollback");
  });
});
