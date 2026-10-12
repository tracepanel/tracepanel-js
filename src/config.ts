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
  };
}
