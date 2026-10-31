import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { tracedFetch, tracedRequest } from "../src/outgoing.js";
import { TracepanelProcessor } from "../src/processor.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (trace) => sent.push(trace) });
// As register() sets it up: the context manager, and the W3C propagator.
const provider = new NodeTracerProvider({ spanProcessors: [processor] });
provider.register();
const tracer = provider.getTracer("test");

// The service called: it answers with the headers it got.
let received: IncomingHttpHeaders = {};
const server = http.createServer((request, response) => {
  received = request.headers;
  response.writeHead(201, { "content-type": "application/json" }).end("{}");
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  context.disable();
});

async function request(handler: () => Promise<void>): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/shipping" },
  });
  await context.with(trace.setSpan(context.active(), root), handler);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return sent.at(-1) as Trace;
}

function call(result: Trace) {
  const spans = result.spans.filter((span) => span.kind === "http.client");
  expect(spans).toHaveLength(1);
  return spans[0];
}

describe("outgoing calls on Bun", () => {
  it("records fetch() as an http.client span, and sends its traceparent", async () => {
    const fetch = tracedFetch(globalThis.fetch);

    const result = await request(async () => {
      await fetch(`${base}/rates?api_key=k`, { method: "POST", headers: { "x-shop": "1" } });
    });

    const span = call(result);
    expect(span?.name).toBe("POST 127.0.0.1/rates");
    expect(span?.attrs).toEqual({
      "http.request.method": "POST",
      "url.full": `${base}/rates?api_key=********`,
      "url.scheme": "http",
      "server.address": "127.0.0.1",
      "server.port": Number(new URL(base).port),
      "http.response.status_code": 201,
      "w3c.span_id": expect.stringMatching(/^[0-9a-f]{16}$/),
      "code.origin": null,
    });

    expect(received.traceparent).toBe(`00-${result.attrs["w3c.trace_id"]}-${span?.attrs["w3c.span_id"]}-01`);
    expect(received["x-shop"]).toBe("1");
  });

  it("records node:http's request() as an http.client span, and sends its traceparent", async () => {
    const send = tracedRequest(http.request, "http");

    const result = await request(
      () =>
        new Promise<void>((done) => {
          send(`${base}/labels`, (response) => {
            response.resume();
            response.on("end", done);
          }).end();
        }),
    );

    const span = call(result);
    expect(span?.name).toBe("GET 127.0.0.1/labels");
    expect(span?.attrs["http.response.status_code"]).toBe(201);

    expect(received.traceparent).toBe(`00-${result.attrs["w3c.trace_id"]}-${span?.attrs["w3c.span_id"]}-01`);
  });

  it("leaves a call outside a trace alone", async () => {
    const fetch = tracedFetch(globalThis.fetch);

    await fetch(`${base}/ping`);

    expect(received.traceparent).toBeUndefined();
  });
});
