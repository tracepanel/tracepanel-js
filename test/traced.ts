// The process's Tracepanel for a framework's tests, as `--import @tracepanel/js/register` sets it up: Node's HTTP
// server traced by OpenTelemetry's instrumentation, each request's trace made by the real processor and kept here
// instead of going to an agent, the console at http://127.0.0.1:9/. The test files are the app's code.

import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import type { Runtime } from "../src/runtime.js";
import { badge } from "../src/widget.js";

const KEY = Symbol.for("tracepanel.runtime");

/** The project: this repository, its tests the app's code. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url)).slice(0, -1);

/** A form posted as a browser posts it, with a cookie of a redirect before. */
export const FORM = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "text/html",
  "Sec-Fetch-Mode": "navigate",
  Cookie: "theme=dark; sessionid=abc; tracepanel_redirect=01EARLIER",
};

export const SCRIPT = /^<script src="http:\/\/127\.0\.0\.1:9\/widget\.min\.js" [^>]*><\/script>$/;

const traces: Trace[] = [];
const config: Config = { ...loadConfig({}), enabled: true, root: ROOT, service: "shop" };
const processor = new TracepanelProcessor(config, { submit: (done) => traces.push(done) });
export const tracepanel: Runtime = {
  config,
  processor,
  starter: { ensure: () => false } as unknown as Starter,
  console: { get: () => "http://127.0.0.1:9/" } as unknown as ConsoleUrl,
  badge: (request) => badge(tracepanel, request),
};
(globalThis as Record<symbol, unknown>)[KEY] = tracepanel;

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
new NodeTracerProvider({ spanProcessors: [processor] }).register();
registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });
// Loaded through require, node:http is patched: its server's prototype is the one ES modules import too.
createRequire(import.meta.url)("node:http");

/** `test/<file>:<line>`: where the line with this comment is, in a file of the tests. */
export function line(file: string, comment: string): string {
  const lines = readFileSync(new URL(file, import.meta.url), "utf8").split("\n");
  return `test/${file}:${lines.findIndex((text) => text.includes(`// ${comment}`)) + 1}`;
}

/** A request with exactly these headers, as a browser sends it (fetch() sets its own Sec-Fetch-Mode). */
export function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(url, { method, headers, agent: false }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

/** The trace a response named in its Tracepanel-Id header, once its last spans are in. */
export async function traceOf(response: Response | { headers: IncomingHttpHeaders }): Promise<Trace> {
  const id =
    response.headers instanceof Headers ? response.headers.get("tracepanel-id") : response.headers["tracepanel-id"];
  for (let waited = 0; waited < 2000; waited += 10) {
    const found = traces.find((trace) => trace.id === id);
    if (found) return found;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no trace ${id}`);
}

/** The spans of a trace as kind, name and the attributes asked for, root first, each under its parent. */
export function tree(trace: Trace, ...keys: string[]): unknown[] {
  const byParent = (parent: string | null): unknown[] =>
    trace.spans
      .filter((span) => span.parent_id === parent)
      .sort((a, b) => a.start - b.start)
      .map((span) => {
        const picked = Object.fromEntries(keys.filter((key) => key in span.attrs).map((key) => [key, span.attrs[key]]));
        const children = byParent(span.id);
        return {
          kind: span.kind,
          name: span.name,
          ...(Object.keys(picked).length > 0 ? { attrs: picked } : {}),
          ...(children.length > 0 ? { children } : {}),
        };
      });
  return byParent(null);
}
