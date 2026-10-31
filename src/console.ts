// console.* calls made during a request go to its trace, then on to the terminal as before. A developer's own debug
// output (console.dir(), a console.log() of an object) goes there as a dump (dumps.ts).

import { format } from "node:util";
import type { Config } from "./config.js";
import { DUMPING, dump, isDump } from "./dumps.js";
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
// How deep the stack at a dump is read: console's wrappers (a dev overlay's) above the app's frame.
const DUMP_DEPTH = 20;

/** Where captured calls go: the processor, and the project's settings (none: no dumps). Set by the last capture. */
interface Capture {
  processor: TracepanelProcessor;
  config: Pick<Config, "root" | "dumps"> | undefined;
}

let quiet = 0;

/**
 * Runs a logger's own write (pino's, winston's): it recorded the log already, so what it prints through console is
 * not recorded again.
 */
export function quietly<T>(write: () => T): T {
  quiet++;
  try {
    return write();
  } finally {
    quiet--;
  }
}

/**
 * Each of console's methods becomes a property whose value records the call, then runs the method as it is now:
 * something that replaces it later (Nuxt's dev server puts its own logger there) replaces what runs, not the record.
 * A later capture (Nuxt's plugin) only changes where the calls go.
 */
export function captureConsole(processor: TracepanelProcessor, config?: Pick<Config, "root" | "dumps">): void {
  const target = console as unknown as Record<string, unknown> & { [CAPTURED]?: Capture };
  const captured = target[CAPTURED];
  if (captured) {
    captured.processor = processor;
    captured.config = config ?? captured.config;
    return;
  }
  const capture: Capture = { processor, config };
  target[CAPTURED] = capture;
  for (const method of new Set([...Object.keys(LEVELS), ...DUMPING])) {
    const level = LEVELS[method];
    let current = target[method] as (...args: unknown[]) => void;
    const recorded = (...args: unknown[]) => {
      if (quiet > 0) return current.apply(console, args);
      const { processor, config } = capture;
      if (config?.dumps && isDump(method, args) && processor.current()) {
        const found = dumpOf(method, args, config.root);
        if (found) {
          processor.addLog(found);
          return current.apply(console, args);
        }
      }
      if (level) {
        const error = args.find((arg): arg is Error => arg instanceof Error);
        processor.addLog({
          time: Date.now() * 1000,
          level,
          logger: "console",
          message: format(...args),
          exception: error?.stack ?? null,
          attrs: {},
        });
      }
      return current.apply(console, args);
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

/** The dump of a console call, or null: not the app's own call, or anything gone wrong (the call goes on). */
function dumpOf(method: string, args: unknown[], root: string): Omit<Log, "span_id"> | null {
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = Math.max(limit, DUMP_DEPTH);
    return dump(method, args, new Error().stack, root);
  } catch {
    return null;
  } finally {
    Error.stackTraceLimit = limit;
  }
}
