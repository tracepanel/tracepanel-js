// The Vitest plugin: what it adds to the config, and the rules a test's meta.tracepanel and its suites' give it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UsageError } from "../src/testing.js";
import { rules, testTrace, tracepanel } from "../src/vitest.js";

const FAKE = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const SETUP = fileURLToPath(new URL("../src/vitest-setup.ts", import.meta.url));
const DEFAULT = new Set(["n+1", "duplicates"] as const);

describe("rules", () => {
  test("are the plugin's without any of the test's own", () => {
    expect(rules({ meta: {} }, DEFAULT)).toEqual({ failOn: new Set(["n+1", "duplicates"]), maxQueries: undefined });
  });

  test("are the test's own, then its suites', the nearest first, each rule on its own", () => {
    const file = { meta: { tracepanel: { maxQueries: 20, failOn: ["slow-sql"] } } };
    const suite = { meta: { tracepanel: { allow: "n+1", maxQueries: 10 } }, suite: file };

    expect(rules({ meta: { tracepanel: { maxQueries: 3 } }, suite }, DEFAULT)).toEqual({
      failOn: new Set(["slow-sql"]),
      maxQueries: 3,
    });
    expect(rules({ meta: {}, suite: { meta: {}, suite } }, DEFAULT)).toEqual({
      failOn: new Set(["slow-sql"]),
      maxQueries: 10,
    });
    expect(rules({ meta: { tracepanel: { failOn: ["n+1", "error"] } }, suite }, DEFAULT)).toEqual({
      failOn: new Set(["error"]),
      maxQueries: 10,
    });
  });

  test("that say something wrong are the test's failure, with what", () => {
    const wrong = (tracepanel: unknown) => () => rules({ meta: { tracepanel } }, DEFAULT);

    expect(wrong({ max_queries: 3, allow: [] })).toThrow(
      new UsageError("meta.tracepanel has no max_queries (allow, failOn, maxQueries)"),
    );
    expect(wrong({ maxQueries: 2.5 })).toThrow(new UsageError("maxQueries must be a whole number, got 2.5"));
    expect(wrong({ maxQueries: "3" })).toThrow(new UsageError('maxQueries must be a whole number, got "3"'));
    expect(wrong(["n+1"])).toThrow(
      new UsageError('meta.tracepanel takes an object (allow, failOn, maxQueries), got ["n+1"]'),
    );
    expect(wrong({ allow: ["n+2"] })).toThrow(
      new UsageError(
        "allow: unknown kind n+2 (the kinds: n+1, duplicates, slow-sql, slow-http, slow-call, error, " +
          "long-transaction, in-transaction, htmx, queue-wait, blocking-call, large-result)",
      ),
    );
  });
});

describe("the plugin", () => {
  let store: string;

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "tracepanel-vitest-test-"));
    process.env.TRACEPANEL_DIR = store;
    process.env.TRACEPANEL_AGENT_BIN = FAKE;
    delete process.env.TRACEPANEL_AGENT;
  });

  afterEach(() => {
    delete process.env.TRACEPANEL_DIR;
    delete process.env.TRACEPANEL_AGENT_BIN;
    delete process.env.TRACEPANEL_AGENT;
    rmSync(store, { recursive: true, force: true });
  });

  async function configured(plugin: ReturnType<typeof tracepanel>, test: Record<string, unknown>): Promise<unknown> {
    const config = { test };
    await (plugin.config as (config: unknown) => Promise<void>)(config);
    return config.test;
  }

  test("puts its setup file first, the test's location on, and the agent's console in what the tests get", async () => {
    expect(await configured(tracepanel(), { setupFiles: "./db.ts", provide: { db: "test" } })).toEqual({
      setupFiles: [SETUP, "./db.ts"],
      includeTaskLocation: true,
      provide: {
        db: "test",
        tracepanel: { failOn: ["n+1", "duplicates"], console: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/) },
      },
    });
  });

  test("without an agent, gives the tests no console; failOn says what fails", async () => {
    process.env.TRACEPANEL_AGENT = "off";

    expect(await configured(tracepanel({ failOn: "slow-sql" }), { setupFiles: [SETUP] })).toEqual({
      setupFiles: [SETUP],
      includeTaskLocation: true,
      provide: { tracepanel: { failOn: ["slow-sql"], console: "" } },
    });
  });

  test("with a misspelled kind is an error as the config loads", () => {
    expect(() => tracepanel({ failOn: ["n+1", "dupes" as "n+1"] })).toThrow(
      new UsageError(
        "tracepanel({ failOn }): unknown kind dupes (the kinds: n+1, duplicates, slow-sql, slow-http, slow-call, " +
          "error, long-transaction, in-transaction, htmx, queue-wait, blocking-call, large-result)",
      ),
    );
  });
});

test("testTrace() outside a test's trace says what it needs", () => {
  expect(() => testTrace()).toThrow(
    new UsageError(
      "testTrace() needs a test's trace, and none is running: add tracepanel() to the plugins of the Vitest config",
    ),
  );
});
