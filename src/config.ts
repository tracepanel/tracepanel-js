import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** Where Tracepanel keeps its state and what it calls the app: from TRACEPANEL_* variables and the project. */
export interface Config {
  enabled: boolean;
  /** The project's directory: paths in stacks are relative to it, and the store lives in it. */
  root: string;
  /** The store directory the agent uses (.tracepanel), where it leaves its addresses. */
  storeDir: string;
  /** The app's name on the service map: TRACEPANEL_SERVICE, package.json's name, or the directory's. */
  service: string;
  maxTraces: number;
  /** The agent's limits for the issues it finds, as the Python SDK names them: TRACEPANEL_SLOW_SQL_MS and so on. */
  thresholds: Thresholds;
}

/** What the agent reports, and from when. Its defaults are these too. */
export interface Thresholds {
  /** Repeats of one statement or call in a request that make an N+1. */
  n_plus_one: number;
  /** For calls to memory stores (Redis, a cache): an N+1 only once the repeats cost this much together. */
  n_plus_one_min_ms: number;
  slow_sql_ms: number;
  /** Outgoing HTTP calls, and RPC calls. */
  slow_http_ms: number;
  long_transaction_ms: number;
  /** A task that waited this long in its queue. */
  queue_wait_ms: number;
  /** A SELECT without a LIMIT that returned this many rows. */
  large_result_rows: number;
}

const THRESHOLDS: Record<keyof Thresholds, [string, number]> = {
  n_plus_one: ["TRACEPANEL_N_PLUS_ONE_THRESHOLD", 3],
  n_plus_one_min_ms: ["TRACEPANEL_N_PLUS_ONE_MIN_MS", 5],
  slow_sql_ms: ["TRACEPANEL_SLOW_SQL_MS", 100],
  slow_http_ms: ["TRACEPANEL_SLOW_HTTP_MS", 500],
  long_transaction_ms: ["TRACEPANEL_LONG_TRANSACTION_MS", 500],
  queue_wait_ms: ["TRACEPANEL_QUEUE_WAIT_MS", 1000],
  large_result_rows: ["TRACEPANEL_LARGE_RESULT_ROWS", 1000],
};

function thresholds(env: NodeJS.ProcessEnv): Thresholds {
  const found = {} as Thresholds;
  for (const [name, [variable, fallback]] of Object.entries(THRESHOLDS) as [keyof Thresholds, [string, number]][]) {
    const value = Number(env[variable]);
    found[name] = Number.isFinite(value) && env[variable] !== undefined && env[variable] !== "" ? value : fallback;
  }
  return found;
}

const OFF = new Set(["0", "false", "no", "off"]);

/** On in development: unless NODE_ENV is production, or TRACEPANEL_ENABLED turns it off (or on). */
function enabled(env: NodeJS.ProcessEnv): boolean {
  const explicit = env.TRACEPANEL_ENABLED?.toLowerCase();
  if (explicit !== undefined && explicit !== "") return !OFF.has(explicit);
  return env.NODE_ENV !== "production";
}

function packageName(root: string): string | undefined {
  try {
    const name: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = resolve(env.TRACEPANEL_ROOT ?? process.cwd());
  return {
    enabled: enabled(env),
    root,
    storeDir: resolve(root, env.TRACEPANEL_DIR ?? ".tracepanel"),
    service: env.TRACEPANEL_SERVICE || packageName(root) || basename(root),
    maxTraces: Number(env.TRACEPANEL_MAX_TRACES) || 2000,
    thresholds: thresholds(env),
  };
}
