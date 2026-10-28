// A request asked to be profiled (its X-Tracepanel-Profile header, the panel's cookie) asks the same of the apps it
// calls: each call that carries a traceparent carries X-Tracepanel-Profile too, so the whole chain is profiled. A
// trace the `profile` setting profiles asks nothing of them.
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { context, propagation, SpanKind, trace } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { tracedFetch, tracedRequest } from "../src/outgoing.js";
import { TracepanelProcessor } from "../src/processor.js";
import { requested } from "../src/profile.js";
import { profilePropagator } from "../src/propagation.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const processor = new TracepanelProcessor(config, { submit: () => undefined });
// As register() sets it up: the context manager, the W3C propagators and the profile's ask.
const provider = new NodeTracerProvider({ spanProcessors: [processor] });
provider.register({ propagator: profilePropagator((spanId) => processor.askedBy(spanId)) });
const tracer = provider.getTracer("test");
// Node's fetch(), through undici's diagnostics channel.
const undici = new UndiciInstrumentation();
const unregister = registerInstrumentations({ instrumentations: [undici] });

/** A call as on Bun, whose fetch has no undici channel: Node's instrumentation off meanwhile, not a second header. */
async function onBun<T>(call: () => Promise<T>): Promise<T> {
  undici.disable();
  try {
    return await call();
  } finally {
    undici.enable();
  }
}

// The service called: it answers with the headers it got.
let received: IncomingHttpHeaders = {};
const server = http.createServer((request, response) => {
  received = request.headers;
  response.writeHead(200, { "content-type": "application/json" }).end("{}");
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  unregister();
  server.close();
  context.disable();
});

/**
 * What the service got from a call made in a request that asked (`asked`, as Node's HTTP server marks the request's
 * root span) for: the traceparent and X-Tracepanel-Profile headers.
 */
async function calledIn(asked: string | undefined, call: () => Promise<unknown>): Promise<Record<string, unknown>> {
  received = {};
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": "GET",
      "url.path": "/books",
      ...(asked ? { "tracepanel.profile": asked } : {}),
    },
  });
  await context.with(trace.setSpan(context.active(), root), call);
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  return {
    traceparent: typeof received.traceparent === "string",
    profile: received["x-tracepanel-profile"],
  };
}

/** node:http's request(), as Bun's calls are traced (outgoing.ts): its headers set on the ClientRequest. */
function httpGet(headers: Record<string, string> = {}): Promise<void> {
  const request = tracedRequest(http.request, "http");
  return new Promise((done, failed) => {
    const sent = request(`${base}/authors/1`, { headers }, (response) => {
      response.resume();
      response.once("end", done);
    });
    sent.once("error", failed);
    sent.end();
  });
}

describe("a profiled request's calls", () => {
  it("ask the app they call for a profile with the same header: fetch(), Bun's fetch and node:http", async () => {
    const node = await calledIn("1", () => fetch(`${base}/authors/1`));
    const bun = await onBun(() => calledIn("1", () => tracedFetch(globalThis.fetch)(`${base}/authors/1`)));
    const plain = await calledIn("1", () => httpGet());

    expect(node).toEqual({ traceparent: true, profile: "1" });

    expect(bun).toEqual({ traceparent: true, profile: "1" });

    expect(plain).toEqual({ traceparent: true, profile: "1" });
  });

  it("ask for the memory too when the request did", async () => {
    const node = await calledIn("memory", () => fetch(`${base}/authors/1`));
    const plain = await calledIn("memory", () => httpGet());

    expect(node).toEqual({ traceparent: true, profile: "memory" });

    expect(plain).toEqual({ traceparent: true, profile: "memory" });
  });

  it("ask what the panel's cookie asked for", async () => {
    const asked = requested({ cookie: "theme=dark; tracepanel_profile=memory" });

    const node = await calledIn(asked, () => fetch(`${base}/authors/1`));

    expect(node).toEqual({ traceparent: true, profile: "memory" });
  });

  it("keep the app's own header", async () => {
    const bun = await onBun(() =>
      calledIn("memory", () =>
        tracedFetch(globalThis.fetch)(`${base}/authors/1`, { headers: { "X-Tracepanel-Profile": "1" } }),
      ),
    );
    const plain = await calledIn("memory", () => httpGet({ "X-Tracepanel-Profile": "1" }));

    expect(bun).toEqual({ traceparent: true, profile: "1" });

    expect(plain).toEqual({ traceparent: true, profile: "1" });
  });

  it("put it beside the traceparent in a plain object of headers, as node:http's instrumentation injects", async () => {
    const injected: Record<string, string> = {};
    const kept: Record<string, string> = { "x-tracepanel-profile": "1" };

    await calledIn("memory", async () => {
      const span = tracer.startSpan("GET", { kind: SpanKind.CLIENT });
      const inside = trace.setSpan(context.active(), span);
      propagation.inject(inside, injected);
      propagation.inject(inside, kept);
      span.end();
    });

    expect(Object.keys(injected).sort()).toEqual(["traceparent", "x-tracepanel-profile"]);
    expect(injected["x-tracepanel-profile"]).toBe("memory");

    expect(kept["x-tracepanel-profile"]).toBe("1");
  });
});

describe("calls that ask for nothing", () => {
  it("are those of a request that didn't ask", async () => {
    const node = await calledIn(undefined, () => fetch(`${base}/authors/1`));
    const plain = await calledIn(undefined, () => httpGet());

    expect(node).toEqual({ traceparent: true, profile: undefined });

    expect(plain).toEqual({ traceparent: true, profile: undefined });
  });

  it("are those of a trace the setting profiles: the next app's own setting decides", async () => {
    config.profile = true;
    try {
      const node = await calledIn(undefined, () => fetch(`${base}/authors/1`));

      expect(node).toEqual({ traceparent: true, profile: undefined });
    } finally {
      config.profile = false;
    }
  });

  it("are those of a request that asked while profiling is off here", async () => {
    config.profileEnabled = false;
    try {
      const node = await calledIn("1", () => fetch(`${base}/authors/1`));

      expect(node).toEqual({ traceparent: true, profile: undefined });
    } finally {
      config.profileEnabled = true;
    }
  });
});
