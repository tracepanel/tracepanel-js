// console.* calls made during a request go to its trace, then on to the terminal as before.

import { format } from "node:util";
import type { Log } from "./model.js";
import type { TracepanelProcessor } from "./processor.js";

const LEVELS: Record<string, Log["level"]> = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warning",
  error: "error",
};

const CAPTURED = Symbol.for("tracepanel.console");

/**
 * Each of console's methods becomes a property whose value records the call, then runs the method as it is now:
 * something that replaces it later (Nuxt's dev server puts its own logger there) replaces what runs, not the record.
 */
export function captureConsole(processor: TracepanelProcessor): void {
  const target = console as unknown as Record<string, unknown> & { [CAPTURED]?: boolean };
  if (target[CAPTURED]) return;
  target[CAPTURED] = true;
  for (const [method, level] of Object.entries(LEVELS)) {
    let current = target[method] as (...args: unknown[]) => void;
    const recorded = (...args: unknown[]) => {
      const error = args.find((arg): arg is Error => arg instanceof Error);
      processor.addLog({
        time: Date.now() * 1000,
        level,
        logger: "console",
        message: format(...args),
        exception: error?.stack ?? null,
        attrs: {},
      });
      current.apply(console, args);
    };
    Object.defineProperty(console, method, {
      configurable: true,
      enumerable: true,
      get: () => recorded,
      set: (replacement: (...args: unknown[]) => void) => {
        current = replacement;
      },
    });
  }
}
