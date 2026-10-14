// tracepanel/vite: the widget and the browser recording in the page, and the backend's console on Vite's origin,
// for this machine only, with the backend's agent started when none runs yet.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { tracepanel } from "../src/vite.js";

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const FAKE = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
let root: string;
let servers: Server[] = [];

/** The plugin's middleware under /__tracepanel__/, as Vite mounts it (the prefix taken off the URL). */
function middleware(options: Parameters<typeof tracepanel>[0]): Handler {
  let handler: Handler | undefined;
  tracepanel(options).configureServer({
    config: { root },
    middlewares: { use: (_path, use) => (handler = use) },
  });
  if (!handler) throw new Error("the plugin mounted nothing");
  return handler;
}

/** An HTTP server on this machine around a handler; its address. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Vite's server with the plugin: /__tracepanel__/<path> reaches the middleware as /<path>. */
async function vite(options: Parameters<typeof tracepanel>[0]): Promise<string> {
  const handler = middleware(options);
  return serve((req, res) => {
    req.url = (req.url ?? "/").replace(/^\/__tracepanel__/, "");
    handler(req, res, () => undefined);
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tracepanel-vite-test-"));
  mkdirSync(join(root, "backend"));
  mkdirSync(join(root, "front"));
  root = join(root, "front");
  process.env["TRACEPANEL_AGENT_BIN"] = FAKE;
  delete process.env["TRACEPANEL_CONSOLE"];
});

afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
  rmSync(join(root, ".."), { recursive: true, force: true });
});

test("a client on another machine gets no console", () => {
  const handler = middleware({ dir: "../backend" });
  const answer: { status?: number; body?: string } = {};
  const res = {
    writeHead: (status: number) => (answer.status = status),
    end: (body: string) => (answer.body = body),
  } as unknown as ServerResponse;

  handler({ url: "/api/traces", socket: { remoteAddress: "10.0.0.5" } } as IncomingMessage, res, () => undefined);

  expect(answer).toEqual({ status: 403, body: "The Tracepanel console answers on this machine only." });
});

test("the page's first load starts the backend's agent when none runs, and gets its console", async () => {
  const base = await vite({ dir: "../backend" });

  const response = await fetch(`${base}/__tracepanel__/widget.min.js`);

  expect([response.status, await response.text()]).toEqual([200, "console /widget.min.js"]);
});

test("a console given is used as it is, nothing started", async () => {
  const backend = await serve((req, res) => res.end(`backend ${req.url}`));
  const base = await vite({ console: `${backend}/__tracepanel__/` });

  expect(await (await fetch(`${base}/__tracepanel__/api/counts`)).text()).toBe("backend /__tracepanel__/api/counts");
});

test("the page gets the widget, and the recording that leaves Vite's own client out", () => {
  const tags = tracepanel({ browser: { service: "shop-web" } }).transformIndexHtml();

  expect(tags.map((tag) => tag.attrs)).toEqual([
    { type: "module" },
    { src: "/__tracepanel__/widget.min.js", "data-tracepanel-api": "/__tracepanel__/", defer: true },
  ]);
  expect(JSON.parse(tags[0]?.children?.match(/record\((.*)\);$/)?.[1] ?? "null")).toEqual({
    api: "/__tracepanel__/",
    ignoreSources: ["/@vite/", "/@react-refresh"],
    service: "shop-web",
  });
});

test("browser: false leaves the recording out", () => {
  expect(
    tracepanel({ browser: false })
      .transformIndexHtml()
      .map((tag) => tag.attrs["src"]),
  ).toEqual(["/__tracepanel__/widget.min.js"]);
});
