// @tracepanel/js/next in development: the app's own server answers /__tracepanel__/ with the project's agent's console,
// starting the agent when none runs, for this machine only; `<Tracepanel />` puts the page's recording and the widget
// from that origin into the root layout.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { ReactElement } from "react";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { ConsoleUrl, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { serveConsole } from "../src/next.js";
import { Tracepanel } from "../src/next-widget.js";
import type { TracepanelProcessor } from "../src/processor.js";
import type { Runtime } from "../src/runtime.js";
import { badge } from "../src/widget.js";

// The recording as the build serves it, an ES module: this one keeps the settings it started with.
vi.mock("../src/proxy.js", async (original) => ({
  ...(await original<typeof import("../src/proxy.js")>()),
  browserModule: () => "const started = [];\nexport function record(options) {\n  globalThis.recorded = options;\n}\n",
}));

/** What `<Tracepanel />` renders with the recording: its inline script, then the widget's tag. */
type Script = ReactElement<Record<string, string | boolean> & { dangerouslySetInnerHTML: { __html: string } }>;
type Rendered = ReactElement<{ children: [Script, Script] }>;

const FAKE = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const KEY = Symbol.for("tracepanel.runtime");
const store = mkdtempSync(join(tmpdir(), "tracepanel-next-test-"));
process.env.TRACEPANEL_AGENT_BIN = FAKE;

/** The process's Tracepanel as register() leaves it, its request the page being rendered (trace 01TRACE). */
const processor = {
  timing: () => ({ id: "01TRACE", queries: 2, dbMs: 1.5, startedMs: performance.now() }),
  framework: () => "Next.js",
} as unknown as TracepanelProcessor;
const tracepanel: Runtime = {
  config: { ...loadConfig({}), enabled: true, storeDir: store },
  processor,
  starter: new Starter(store),
  console: new ConsoleUrl(store),
  badge: (request) => badge(tracepanel, request),
};
(globalThis as Record<symbol, unknown>)[KEY] = tracepanel;

// Next's server is made before the instrumentation hook runs: the console has to reach it all the same.
const app: Server = createServer((req, res) => res.end(`app ${req.url}`));
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
serveConsole(tracepanel);

beforeEach(() => {
  for (const name of ["agent.addr", "console.addr"]) rmSync(join(store, name), { force: true });
});

afterAll(() => {
  app.close();
  // The fake agents exit on their own within a minute: only the store goes now.
  rmSync(store, { recursive: true, force: true });
});

test("the app's server answers /__tracepanel__/ with the console of the agent it starts, the rest as before", async () => {
  const widget = await fetch(`${base}/__tracepanel__/widget.min.js`);
  const page = await fetch(`${base}/books`);

  expect([widget.status, await widget.text()]).toEqual([200, "console /widget.min.js"]);
  expect(await page.text()).toBe("app /books");
});

test("an agent that went away is started anew, and the request goes to its console", async () => {
  // The agent killed or replaced by a new build: its addresses stay, nobody answers there.
  writeFileSync(join(store, "console.addr"), "http://127.0.0.1:9/\n");
  writeFileSync(join(store, "agent.addr"), "tcp:127.0.0.1:9\n");

  const answer = await fetch(`${base}/__tracepanel__/api/counts`);

  expect([answer.status, await answer.text()]).toEqual([200, "console /api/counts"]);
});

test("a client on another machine gets no console, and Next.js never sees the request", () => {
  const answer: { status?: number; body?: string } = {};
  const res = {
    writeHead: (status: number) => (answer.status = status),
    end: (body: string) => (answer.body = body),
  } as unknown as ServerResponse;
  const req = { url: "/__tracepanel__/api/traces", socket: { remoteAddress: "10.0.0.5" } } as IncomingMessage;

  expect(app.emit("request", req, res)).toBe(true);

  expect(answer).toEqual({ status: 403, body: "The Tracepanel console answers on this machine only." });
});

test("the page records itself before the app's scripts run, then gets the widget, both from the app's origin", () => {
  const rendered = Tracepanel({ browser: { service: "shop-web", propagateTo: ["http://127.0.0.1:8000"] } });
  const [recording, widget] = (rendered as Rendered).props.children;
  const script = recording.props.dangerouslySetInnerHTML.__html;

  expect(widget.props).toEqual({
    src: "/__tracepanel__/widget.min.js",
    "data-tracepanel-api": "/__tracepanel__/",
    "data-tracepanel-id": "01TRACE",
    "data-tracepanel-method": "GET",
    "data-tracepanel-status": "200",
    "data-tracepanel-total": expect.any(String),
    "data-tracepanel-db": "1.5",
    "data-tracepanel-queries": "2",
    "data-tracepanel-issues": "pending",
    "data-tracepanel-runtime": expect.stringMatching(/ · Next\.js$/),
    async: true,
  });

  // A classic script: it runs as the parser reaches it, and starts the recording with the layout's settings.
  expect(runInNewContext(`${script}; globalThis.recorded`, {})).toEqual({
    api: "/__tracepanel__/",
    ignoreSources: ["_next_dist_client_", "_browser_dev_hmr-client_", "/next/dist/client/"],
    service: "shop-web",
    propagateTo: ["http://127.0.0.1:8000"],
  });
});

test("the recording's settings can't end its script tag", () => {
  const rendered = Tracepanel({ browser: { service: "</script><script>alert(1)</script>" } });
  const [recording] = (rendered as Rendered).props.children;

  expect(recording.props.dangerouslySetInnerHTML.__html).not.toContain("</script>");
});

test("browser: false leaves the recording out", () => {
  expect((Tracepanel({ browser: false }) as Script).props.src).toBe("/__tracepanel__/widget.min.js");
});

test("outside development the layout gets nothing", () => {
  delete (globalThis as Record<symbol, unknown>)[KEY];

  expect(Tracepanel()).toBeNull();

  (globalThis as Record<symbol, unknown>)[KEY] = tracepanel;
});
