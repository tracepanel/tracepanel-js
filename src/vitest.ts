// Tracepanel's Vitest plugin: each test a trace, and what the agent finds in it (an N+1, duplicate queries) a failure.
//
//   // vitest.config.ts
//   import { tracepanel } from "@tracepanel/js/vitest";
//   export default defineConfig({ plugins: [tracepanel()] });   // tracepanel({ failOn: ["n+1", "slow-sql"] })
//
//   test("feed", { meta: { tracepanel: { maxQueries: 10, allow: ["n+1"] } } }, async () => {
//     await request(app).get("/feed");
//     expect(testTrace().queries).toBeLessThanOrEqual(10);
//     await maxQueries(2, () => request(app).get("/feed?page=2"));
//   });
//
// The plugin adds a setup file to each test file (vitest-setup.ts): it turns Tracepanel on in the test's process as
// `node --import @tracepanel/js/register` does, with the widget off, and runs each test as a trace. The plugin starts
// the project's agent once, as Vitest starts, unless one answers. Once a test has passed, the agent is asked what it
// found in the test's trace and in its requests': a finding of a kind it fails on fails the test, with the finding,
// its query, where the code made it and a link to the trace in the console. Without an agent the tests run as usual,
// and a single warning says that findings are not checked: counting queries needs no agent.

import { fileURLToPath } from "node:url";
import type { Plugin } from "vitest/config";
import type { VitestPluginContext } from "vitest/node";
import { ConsoleUrl, Starter } from "./agent.js";
import { loadConfig } from "./config.js";
import {
  currentTest,
  DEFAULT_FAIL_ON,
  type Finding,
  type Kind,
  kinds,
  type Rules,
  type TracedTest,
  UsageError,
} from "./testing.js";

export type { Finding, Kind } from "./testing.js";
export { KINDS, maxQueries } from "./testing.js";

/** A test's own rules, nearest first: the test's `meta.tracepanel`, then its suites'. */
export interface TestRules {
  /** Fail the test when it and its requests make more queries than this. */
  maxQueries?: number;
  /** The kinds of issues that fail the test, instead of the plugin's `failOn`. */
  failOn?: Kind | Kind[];
  /** Kinds of issues taken out of those that fail the test. */
  allow?: Kind | Kind[];
}

export interface TracepanelOptions {
  /** The kinds of issues that fail a test: n+1 and duplicates by default (the kinds: KINDS). */
  failOn?: Kind | Kind[];
}

/** What the plugin hands each test file's setup. */
export interface Provided {
  failOn: Kind[];
  /** The console the agent serves, or "" without one. */
  console: string;
}

declare module "vitest" {
  interface TaskMeta {
    tracepanel?: TestRules;
  }
  interface ProvidedContext {
    tracepanel: Provided;
  }
}

// This file's own setup file: the built one next to it, or the source in this repository's tests.
const SETUP = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./vitest-setup.ts" : "./vitest-setup.js", import.meta.url),
);

/** Whether the agent's console answers: what the tests read the findings from. */
async function answers(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const answer = await fetch(`${url.replace(/\/+$/, "")}/api/traces?limit=1`, { signal: AbortSignal.timeout(2000) });
    return answer.ok;
  } catch {
    return false;
  }
}

/** The project's agent's console, the agent started now unless one answers: "" when there is none. */
export async function agentConsole(): Promise<string> {
  if (process.env.TRACEPANEL_AGENT === "off") return "";
  const config = loadConfig();
  const consoleUrl = new ConsoleUrl(config.storeDir);
  if (await answers(consoleUrl.get(true))) return consoleUrl.get(true);
  // None answers at the address the project's agent left (it exited, or was killed): a new one starts.
  if (!new Starter(config.storeDir).ensure(true)) return "";
  for (let tries = 0; tries < 20; tries++) {
    if (await answers(consoleUrl.get(true))) return consoleUrl.get(true);
    await new Promise((done) => setTimeout(done, 50));
  }
  return "";
}

function why(): string {
  const named = process.env.TRACEPANEL_AGENT;
  if (named === "off") return "the agent is off (TRACEPANEL_AGENT=off).";
  if (named && named !== "auto") return `no agent's console answers for ${named}.`;
  return "the agent didn't start.";
}

/** Runs each test as a trace, and fails one with an N+1 or duplicate queries (`failOn`: the kinds that fail it). */
export function tracepanel(options: TracepanelOptions = {}): Plugin {
  const failOn = [...kinds(options.failOn ?? [...DEFAULT_FAIL_ON], "tracepanel({ failOn })")];
  let consoleUrl: Promise<string> | undefined;
  return {
    name: "tracepanel",
    async config(config) {
      consoleUrl ??= agentConsole();
      const provided: Provided = { failOn, console: await consoleUrl };
      // First of the setup files: the instrumentation goes in before another's imports load a database driver.
      config.test ??= {};
      const { test } = config;
      const setupFiles = test.setupFiles === undefined ? [] : [test.setupFiles].flat();
      test.setupFiles = [SETUP, ...setupFiles.filter((file) => file !== SETUP)];
      test.includeTaskLocation = true;
      test.provide = { ...test.provide, tracepanel: provided };
    },
    configureVitest({ vitest }: VitestPluginContext) {
      void consoleUrl?.then((url) => {
        const fails = failOn.length > 0 ? [...failOn].sort().join(", ") : "nothing";
        vitest.logger.log(
          `tracepanel: each test a trace · fails on ${fails} · ${url ? `console ${url}` : "no agent: findings not checked"}`,
        );
        if (!url) vitest.logger.warn(`tracepanel: ${why()} The tests run without the agent's findings.`);
      });
    },
  };
}

const RULES = ["allow", "failOn", "maxQueries"];
/** A test or a suite, as far as its rules go. */
interface Node {
  meta?: { tracepanel?: unknown };
  suite?: Node | undefined;
}

/** The test's rules: its `meta.tracepanel`, then its suites', the nearest first, over the plugin's `failOn`. */
export function rules(task: Node, failOn: ReadonlySet<Kind>): Rules {
  const values: Record<string, unknown> = {};
  for (let node: Node | undefined = task; node; node = node.suite) {
    const own = node.meta?.tracepanel;
    if (own === undefined) continue;
    if (typeof own !== "object" || own === null || Array.isArray(own)) {
      throw new UsageError(`meta.tracepanel takes an object (${RULES.join(", ")}), got ${JSON.stringify(own)}`);
    }
    for (const [key, value] of Object.entries(own)) if (!(key in values)) values[key] = value;
  }
  const unknown = Object.keys(values)
    .filter((key) => !RULES.includes(key))
    .sort();
  if (unknown.length > 0) throw new UsageError(`meta.tracepanel has no ${unknown.join(", ")} (${RULES.join(", ")})`);
  const limit = values.maxQueries;
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 0)) {
    throw new UsageError(`maxQueries must be a whole number, got ${JSON.stringify(limit)}`);
  }
  const failing = "failOn" in values ? kinds(values.failOn, "failOn") : new Set(failOn);
  const allowed = kinds(values.allow ?? [], "allow");
  return {
    failOn: new Set([...failing].filter((kind) => !allowed.has(kind))),
    maxQueries: limit as number | undefined,
  };
}

/** The test's trace, as testTrace() gives it: its queries so far, what the agent found, its link in the console. */
export interface TestTrace {
  /** How many queries the test made so far, its requests' included. */
  readonly queries: number;
  /** Those queries, in the order they ended. */
  readonly sql: TracedTest["sql"];
  /** What the agent found so far: in the requests the test made. Empty without an agent. */
  issues(): Promise<Finding[]>;
  /** The test's trace in the agent's console, or undefined without an agent. */
  readonly url: string | undefined;
}

/** The current test's trace: needs tracepanel() in the plugins of the Vitest config. */
export function testTrace(): TestTrace {
  const test = currentTest();
  if (!test) {
    throw new UsageError(
      "testTrace() needs a test's trace, and none is running: add tracepanel() to the plugins of the Vitest config",
    );
  }
  return test;
}
