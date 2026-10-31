// profile() in the app's code: the rest of the current trace is profiled (`profile.reason` "code", unless it was
// profiled already), and its calls to other apps ask them for a profile from then on. Outside a trace, outside
// development or with profiling off it does nothing.
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profile, trace } from "../src/api.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { memoryProfiling } from "../src/profile.js";
import { profilePropagator } from "../src/propagation.js";
import { crunchPrices } from "./app/shop.js";

const KEY = Symbol.for("tracepanel.runtime");
const root = new URL("./app/", import.meta.url).pathname.slice(0, -1);
const config: Config = { ...loadConfig({}), enabled: true, root, service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
const runtime = { config, processor };
(globalThis as Record<symbol, unknown>)[KEY] = runtime;

// As register() sets it up: the context manager, the propagators with the profile's ask, Node's HTTP server and fetch.
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
new NodeTracerProvider({ spanProcessors: [processor] }).register({
  propagator: profilePropagator((spanId) => processor.askedBy(spanId)),
});
const unregister = registerInstrumentations({
  instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
});
// Loaded through require, node:http is patched: its server's prototype is the one ES modules import too.
const http = createRequire(import.meta.url)("node:http") as typeof import("node:http");

/** The X-Tracepanel-Profile header of each call the other service got, by its path. */
const asked: Record<string, string | undefined> = {};
const service = http.createServer((request, response) => {
  const header = request.headers["x-tracepanel-profile"];
  asked[request.url ?? ""] = typeof header === "string" ? header : undefined;
  response.end("{}");
});
let serviceBase = "";

/** What profile() answered in each request, by its path. */
const answered: Record<string, boolean> = {};
const app = express();
app.get("/report", async (_request, response) => {
  await fetch(`${serviceBase}/before`);
  answered["/report"] = profile();
  crunchPrices(30);
  await fetch(`${serviceBase}/after`);
  response.json({});
});
app.get("/memory", async (_request, response) => {
  answered["/memory"] = profile({ memory: true });
  crunchPrices(30);
  await fetch(`${serviceBase}/memory-call`);
  response.json({});
});
app.get("/upgrade", async (_request, response) => {
  answered["/upgrade"] = profile();
  crunchPrices(10);
  await fetch(`${serviceBase}/time-call`);
  answered["/upgrade"] &&= profile({ memory: true });
  crunchPrices(20);
  await fetch(`${serviceBase}/upgraded-call`);
  response.json({});
});
app.get("/plain", async (_request, response) => {
  crunchPrices(5);
  await fetch(`${serviceBase}/plain-call`);
  response.json({});
});
const server = http.createServer(app);
let base = "";

beforeAll(async () => {
  await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
  serviceBase = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  unregister();
  server.close();
  service.close();
  manager.disable();
});

/** The trace of a request to the app, once its last spans are in. */
async function request(path: string): Promise<Trace> {
  const response = await fetch(`${base}${path}`);
  await response.text();
  for (let waited = 0; waited < 2000; waited += 10) {
    const found = sent.find((done) => done.kind === "http" && done.attrs["http.path"] === path);
    if (found) {
      sent.splice(sent.indexOf(found), 1);
      return found;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no trace of ${path}`);
}

/** The trace a trace() of the app's code made, once it is sent. */
async function sentTrace(name: string): Promise<Trace> {
  for (let waited = 0; waited < 2000; waited += 10) {
    const found = sent.find((done) => done.name === name);
    if (found) {
      sent.splice(sent.indexOf(found), 1);
      return found;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no trace ${name}`);
}

describe("profile()", () => {
  it("profiles the rest of a request's trace, its reason the code's, and its later calls ask for a profile", async () => {
    const result = await request("/report");

    expect(answered["/report"]).toBe(true);
    expect(result.attrs["profile.reason"]).toBe("code");
    expect(result.profile).toEqual(expect.objectContaining({ samples: expect.any(Number) }));

    expect(asked).toMatchObject({ "/before": undefined, "/after": "1" });
  });

  it("profiles the memory too with { memory: true }, and asks the same of the calls", async () => {
    const result = await request("/memory");

    expect(answered["/memory"]).toBe(true);
    expect(result.attrs["profile.reason"]).toBe("code");
    if (memoryProfiling()) expect(result.profile?.memory).toEqual(expect.objectContaining({ sites_at: "end" }));

    expect(asked["/memory-call"]).toBe("memory");
  });

  it("adds the memory to a trace profiled for its time already, and asks it of the later calls", async () => {
    const result = await request("/upgrade");

    expect(answered["/upgrade"]).toBe(true);
    expect(result.attrs["profile.reason"]).toBe("code");
    expect(result.profile).toEqual(expect.objectContaining({ samples: expect.any(Number) }));
    if (memoryProfiling()) {
      expect(result.profile?.memory).toEqual(
        expect.objectContaining({ peak: expect.any(Number), net: expect.any(Number), sites_at: "end" }),
      );
    }

    expect(asked).toMatchObject({ "/time-call": "1", "/upgraded-call": "memory" });
  });

  it("adds the memory to a trace the setting profiles, keeping its reason", async () => {
    config.profile = true;
    try {
      const result = await request("/memory");

      expect(answered["/memory"]).toBe(true);
      expect(result.attrs["profile.reason"]).toBe("setting");
      if (memoryProfiling()) expect(result.profile?.memory).toEqual(expect.objectContaining({ sites_at: "end" }));

      expect(asked["/memory-call"]).toBe("memory");
    } finally {
      config.profile = false;
    }
  });

  it("profiles the trace a trace() of the app's code makes", async () => {
    const inside = await trace("nightly report", async () => {
      const profiled = profile();
      crunchPrices(30);
      await fetch(`${serviceBase}/nightly`);
      return profiled;
    });
    const result = await sentTrace("nightly report");

    expect(inside).toBe(true);
    expect(result.attrs["profile.reason"]).toBe("code");
    expect(result.profile).toEqual(expect.objectContaining({ samples: expect.any(Number) }));

    expect(asked["/nightly"]).toBe("1");
  });

  it("keeps the reason of a trace profiled already: the setting's", async () => {
    config.profile = true;
    try {
      const result = await request("/report");

      expect(answered["/report"]).toBe(true);
      expect(result.attrs["profile.reason"]).toBe("setting");

      // A trace the setting profiles asks nothing of the next app, until the code asks.
      expect(asked).toMatchObject({ "/before": undefined, "/after": "1" });
    } finally {
      config.profile = false;
    }
  });

  it("does nothing outside a trace", () => {
    expect(profile()).toBe(false);
    expect(profile({ memory: true })).toBe(false);
  });

  it("does nothing with profiling off, or outside development", async () => {
    config.profileEnabled = false;
    try {
      const result = await request("/report");

      expect(answered["/report"]).toBe(false);
      expect(result.attrs["profile.reason"]).toBeUndefined();
      expect(result.profile).toBeUndefined();

      expect(asked["/after"]).toBeUndefined();
    } finally {
      config.profileEnabled = true;
    }

    delete (globalThis as Record<symbol, unknown>)[KEY];
    try {
      const result = await request("/report");

      expect(answered["/report"]).toBe(false);
      expect(result.attrs["profile.reason"]).toBeUndefined();

      expect(asked["/after"]).toBeUndefined();
    } finally {
      (globalThis as Record<symbol, unknown>)[KEY] = runtime;
    }
  });

  it("leaves a request that doesn't call it unprofiled, its calls asking nothing", async () => {
    const result = await request("/plain");

    expect(result.profile).toBeUndefined();

    expect(asked["/plain-call"]).toBeUndefined();
  });
});
