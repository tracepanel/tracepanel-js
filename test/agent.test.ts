// The SDK starts the project's agent when none answers, and again when the one it started went away.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sender, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import type { Trace } from "../src/model.js";

const FAKE = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
let store: string;

/** The fake agent's console port, from the address it wrote. */
function consolePort(): number {
  return Number(new URL(readFileSync(join(store, "console.addr"), "utf8").trim()).port);
}

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), "tracepanel-agent-test-"));
  process.env.TRACEPANEL_AGENT_BIN = FAKE;
  delete process.env.FAKE_AGENT_FAIL;
  delete process.env.TRACEPANEL_AGENT;
});

afterEach(() => {
  // The fake agents exit on their own within a minute: only the store goes now.
  rmSync(store, { recursive: true, force: true });
});

test("an agent is started when none runs, and its console answers", async () => {
  const starter = new Starter(store);

  expect(starter.ensure()).toBe(true);
  expect(await (await fetch(`http://127.0.0.1:${consolePort()}/widget.min.js`)).text()).toBe("console /widget.min.js");
});

test("an agent that went away is started anew at once, its old addresses replaced", async () => {
  const starter = new Starter(store);
  starter.ensure();
  const first = consolePort();
  // The agent killed or replaced by a new build: its addresses stay, nobody answers there.
  writeFileSync(join(store, "agent.addr"), "tcp:127.0.0.1:9\n");
  writeFileSync(join(store, "console.addr"), "http://127.0.0.1:9/\n");

  expect(await starter.restart()).toBe(true);
  expect(consolePort()).not.toBe(9);
  expect(consolePort()).not.toBe(first);
});

test("a stale unix socket's address is a stopped agent's: a new one starts and is waited for", async () => {
  writeFileSync(join(store, "agent.addr"), `unix:${join(store, "gone.sock")}\n`);

  expect(await new Starter(store).restart()).toBe(true);
  expect(readFileSync(join(store, "agent.addr"), "utf8")).toMatch(/^tcp:127\.0\.0\.1:\d+\n$/);
});

test("an agent that doesn't take the hello yet keeps its addresses, and no second one starts", async () => {
  // Another process's agent, just started: it listens, and answers no hello yet. A second one would fail at once.
  process.env.FAKE_AGENT_FAIL = "1";
  const connections: Socket[] = [];
  const starting = createServer((socket) => connections.push(socket));
  await new Promise<void>((done) => starting.listen(0, "127.0.0.1", done));
  const { port } = starting.address() as AddressInfo;
  writeFileSync(join(store, "agent.addr"), `tcp:127.0.0.1:${port}\n`);
  writeFileSync(join(store, "console.addr"), "http://127.0.0.1:1/\n");
  try {
    const config = loadConfig({ ...process.env, TRACEPANEL_DIR: store, TRACEPANEL_SERVICE: "shop" });
    new Sender(config, new Starter(store)).submit({ id: "T" } as unknown as Trace);
    // Its hello, a bare connect to ask whether it answers at all, and the hello again.
    await vi.waitFor(() => expect(connections.length).toBe(3), { timeout: 4000 });

    expect(readFileSync(join(store, "agent.addr"), "utf8")).toBe(`tcp:127.0.0.1:${port}\n`);
    expect(readFileSync(join(store, "console.addr"), "utf8")).toBe("http://127.0.0.1:1/\n");
  } finally {
    for (const socket of connections) socket.destroy();
    starting.close();
  }
});

test("an agent that can't start isn't tried again on every call", async () => {
  process.env.FAKE_AGENT_FAIL = "1";
  const starter = new Starter(store);

  expect(starter.ensure()).toBe(false);

  delete process.env.FAKE_AGENT_FAIL;

  expect(await starter.restart()).toBe(false);
});

test("an agent named by TRACEPANEL_AGENT is never started", async () => {
  process.env.TRACEPANEL_AGENT = "tcp:127.0.0.1:9";

  expect(await new Starter(store).restart()).toBe(false);
});
