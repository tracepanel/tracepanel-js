// The SDK starts the project's agent when none answers, and again when the one it started went away.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Starter } from "../src/agent.js";

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
  // The agent killed or replaced by a new build: its address stays, nobody answers there.
  writeFileSync(join(store, "console.addr"), "http://127.0.0.1:9/\n");

  expect(starter.ensure(true)).toBe(true);
  expect(consolePort()).not.toBe(9);
  expect(consolePort()).not.toBe(first);
});

test("an agent that can't start isn't tried again on every call", () => {
  process.env.FAKE_AGENT_FAIL = "1";
  const starter = new Starter(store);

  expect(starter.ensure()).toBe(false);

  delete process.env.FAKE_AGENT_FAIL;

  expect(starter.ensure(true)).toBe(false);
});

test("an agent named by TRACEPANEL_AGENT is never started", () => {
  process.env.TRACEPANEL_AGENT = "tcp:127.0.0.1:9";

  expect(new Starter(store).ensure(true)).toBe(false);
});
