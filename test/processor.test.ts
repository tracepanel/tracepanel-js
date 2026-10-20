import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const config: Config = {
  ...loadConfig({}),
  enabled: true,
  root: "/app",
  storeDir: "/app/.tracepanel",
  service: "shop",
  maxTraces: 2000,
};
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (trace) => sent.push(trace) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
const tracer = provider.getTracer("test");

afterAll(() => manager.disable());

function request(): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/books", "http.route": "/books" },
  });
  context.with(trace.setSpan(context.active(), root), () => {
    const middleware = tracer.startSpan("middleware - json", { attributes: { "express.type": "middleware" } });
    context.with(trace.setSpan(context.active(), middleware), () => {
      const handler = tracer.startSpan("request handler - /books", {
        attributes: { "express.type": "request_handler", "express.name": "/books" },
      });
      context.with(trace.setSpan(context.active(), handler), () => {
        for (const id of [1, 2]) {
          tracer
            .startSpan("pg.query:SELECT shop", {
              kind: SpanKind.CLIENT,
              attributes: {
                "db.system": "postgresql",
                "db.statement": "SELECT name FROM authors WHERE id = $1",
                "db.postgresql.values": [id],
              },
            })
            .end();
        }
        processor.addLog({ time: 1, level: "info", logger: "console", message: "listed", exception: null, attrs: {} });
      });
      handler.end();
    });
    middleware.end();
  });
  root.setAttribute("http.response.status_code", 200);
  root.setStatus({ code: SpanStatusCode.UNSET });
  root.end();
  return new Promise((done) => setTimeout(() => done(sent.at(-1) as Trace), 60));
}

describe("TracepanelProcessor", () => {
  it("makes one trace of a request: the request, its handler, its statements, its logs", async () => {
    const result = await request();
    expect(result.name).toBe("GET /books");
    expect(result.attrs).toMatchObject({ "http.route": "/books", "http.status_code": 200, "service.name": "shop" });
    expect(result.spans.map((span) => [span.kind, span.name])).toEqual([
      ["sql", "SELECT authors"],
      ["sql", "SELECT authors"],
      ["view", "/books"],
      ["http", "GET /books"],
    ]);
  });

  it("leaves Express's middleware out and hangs its children on the nearest kept span", async () => {
    const result = await request();
    const view = result.spans.find((span) => span.kind === "view");
    const root = result.spans.find((span) => span.kind === "http");
    expect(view?.parent_id).toBe(root?.id);
    expect(result.spans.filter((span) => span.kind === "sql").every((span) => span.parent_id === view?.id)).toBe(true);
  });

  it("makes no trace of a request to the console on the app's origin: the page's recording sending its traces", async () => {
    const before = sent.length;
    tracer
      .startSpan("POST", {
        kind: SpanKind.SERVER,
        attributes: { "http.request.method": "POST", "url.path": "/__tracepanel__/api/ingest" },
      })
      .end();
    await new Promise((done) => setTimeout(done, 60));

    expect(sent.length).toBe(before);
  });

  it("fingerprints statements and hashes their parameters", async () => {
    const result = await request();
    const [first, second] = result.spans.filter((span) => span.kind === "sql");
    expect(first?.attrs["db.fingerprint"]).toBe("SELECT name FROM authors WHERE id = $1");
    expect(first?.attrs["db.params_hash"]).not.toBe(second?.attrs["db.params_hash"]);
    expect(result.logs.map((log) => log.message)).toEqual(["listed"]);
  });
  it("records what a request carried, found by its URL when its response goes out outside the request's context", async () => {
    const root = tracer.startSpan("POST", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "POST", "http.target": "/books?page=2" },
    });
    processor.setTraceAttrs({ "url.query": "page=2" }, { method: "POST", url: "/books?page=2" });
    processor.setTraceAttrs({ "url.query": "other" }, { method: "GET", url: "/books?page=2" });
    root.setAttribute("http.response.status_code", 303);
    root.end();
    const result = await new Promise<Trace>((done) => setTimeout(() => done(sent.at(-1) as Trace), 60));

    expect(result.attrs).toMatchObject({ "url.query": "page=2", "http.status_code": 303 });
  });
});
