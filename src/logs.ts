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

export function captureConsole(processor: TracepanelProcessor): void {
  for (const [method, level] of Object.entries(LEVELS)) {
    // biome-ignore lint/suspicious/noConsole: wrapping console is the point here
    const original = console[method as keyof Console] as (...args: unknown[]) => void;
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const error = args.find((arg): arg is Error => arg instanceof Error);
      processor.addLog({
        time: Date.now() * 1000,
        level,
        logger: "console",
        message: format(...args),
        exception: error?.stack ?? null,
        attrs: {},
      });
      original.apply(console, args);
    };
  }
}
