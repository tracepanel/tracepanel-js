// console.* calls made during a request go to its trace, then on to the terminal as before. So do Nest's Logger
// calls: Nest writes to the terminal itself, not through console.

import { format } from "node:util";
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from "@opentelemetry/instrumentation";
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

const NEST_LEVELS: Record<string, Log["level"]> = {
  verbose: "debug",
  debug: "debug",
  log: "info",
  warn: "warning",
  error: "error",
  fatal: "critical",
};

type NestMethod = (this: unknown, message: unknown, ...params: unknown[]) => void;

/** `logger.log("created", "BooksService")`: the context is the last string argument, a stack the one before it. */
function nestRecord(level: Log["level"], message: unknown, params: unknown[]): Omit<Log, "span_id"> {
  const context = params.length > 0 && typeof params.at(-1) === "string" ? String(params.at(-1)) : "nest";
  const stack = level === "error" && params.length > 1 && typeof params[0] === "string" ? params[0] : null;
  return {
    time: Date.now() * 1000,
    level,
    logger: context,
    message: message instanceof Error ? message.message : format(message),
    exception: message instanceof Error ? (message.stack ?? null) : stack,
    attrs: {},
  };
}

/** Nest's ConsoleLogger, which Logger and the app's own loggers use unless replaced. */
export class NestLogs extends InstrumentationBase {
  constructor(private readonly processor: TracepanelProcessor) {
    super("tracepanel-nest-logger", "1.0.0", {});
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition("@nestjs/common", [">=8"], (exports) => {
      const prototype = (exports as { ConsoleLogger?: { prototype: Record<string, NestMethod> } }).ConsoleLogger
        ?.prototype;
      if (!prototype) return exports;
      for (const [method, level] of Object.entries(NEST_LEVELS)) {
        const original = prototype[method];
        if (typeof original !== "function" || isWrapped(original)) continue;
        this._wrap(prototype, method, () => {
          const processor = this.processor;
          return function (this: unknown, message: unknown, ...params: unknown[]) {
            processor.addLog(nestRecord(level, message, params));
            return original.call(this, message, ...params);
          };
        });
      }
      return exports;
    });
  }
}
