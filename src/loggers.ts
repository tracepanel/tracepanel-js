// pino's and winston's logs go to the request's or task's trace, as console's do (console.ts): the level on the same
// scale, the logger's own fields as extra.* attributes, the error with its stack. The logger still writes each one
// where the app sends it; what it prints through console is not recorded a second time.

import { format, inspect } from "node:util";
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from "@opentelemetry/instrumentation";
import { quietly } from "./console.js";
import type { Attrs, Log } from "./model.js";
import type { TracepanelProcessor } from "./processor.js";
import { MASK, sensitive } from "./request.js";

type LogRecord = Omit<Log, "span_id">;
type Fields = { [key: string]: unknown };
type Method = (this: unknown, ...args: unknown[]) => unknown;

const WRAPPED = Symbol.for("tracepanel.loggers");

/** A log's own fields as extra.* attributes, the way the Python SDK names the fields of `extra=`. */
export function extraAttrs(fields: Fields, skip: ReadonlySet<string> = new Set()): Attrs {
  const attrs: Attrs = {};
  for (const [name, value] of Object.entries(fields)) {
    if (skip.has(name) || value === undefined || typeof value === "function") continue;
    const key = `extra.${
      name
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "") || "value"
    }`;
    if (sensitive(name)) attrs[key] = MASK;
    else if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      attrs[key] = value;
    else attrs[key] = inspect(value, { depth: 2, breakLength: Number.POSITIVE_INFINITY, maxArrayLength: 20 });
  }
  return attrs;
}

/** Replaces a method once, however many times the module loads (CommonJS and ESM, or two copies of it). */
function wrap(target: object, key: string | symbol, make: (original: Method) => Method): void {
  const holder = target as { [key: string | symbol]: unknown };
  const original = holder[key] as (Method & { [WRAPPED]?: boolean }) | undefined;
  if (typeof original !== "function" || original[WRAPPED]) return;
  const wrapped = make(original) as Method & { [WRAPPED]?: boolean };
  wrapped[WRAPPED] = true;
  holder[key] = wrapped;
}

// pino

interface PinoSymbols {
  writeSym: symbol;
  messageKeySym: symbol;
  errorKeySym: symbol;
}

interface PinoLogger {
  bindings(): Fields;
  [key: symbol]: unknown;
}

type Pino = ((options: object, stream: object) => PinoLogger) & { symbols?: PinoSymbols };

/** pino's numbers: trace 10, debug 20, info 30, warn 40, error 50, fatal 60; a custom level falls between them. */
function pinoLevel(level: number): Log["level"] {
  if (level >= 60) return "critical";
  if (level >= 50) return "error";
  if (level >= 40) return "warning";
  if (level >= 30) return "info";
  return "debug";
}

/** One call as pino's write gets it: the object logged, the message formatted, the level's number. */
export function pinoRecord(
  logger: PinoLogger,
  symbols: PinoSymbols,
  obj: unknown,
  msg: unknown,
  level: number,
): LogRecord {
  const messageKey = (logger[symbols.messageKeySym] as string | undefined) ?? "msg";
  const errorKey = (logger[symbols.errorKeySym] as string | undefined) ?? "err";
  const { name, ...bindings } = logger.bindings();
  const fields: Fields = obj instanceof Error || typeof obj !== "object" || obj === null ? {} : (obj as Fields);
  const error = obj instanceof Error ? obj : fields[errorKey] instanceof Error ? (fields[errorKey] as Error) : null;
  const message = msg ?? fields[messageKey] ?? error?.message ?? "";
  return {
    time: Date.now() * 1000,
    level: pinoLevel(level),
    logger: typeof name === "string" ? name : "pino",
    message: typeof message === "string" ? message : format(message),
    exception: error ? (error.stack ?? String(error)) : null,
    attrs: { ...extraAttrs(bindings), ...extraAttrs(fields, new Set([messageKey, ...(error ? [errorKey] : [])])) },
  };
}

/**
 * Every pino logger, its children too, writes each enabled call through one method of the prototype they share
 * (pino.symbols.writeSym): wrapped, it records the call as the app made it, whichever destination or transport the
 * logger has. The prototype is reached through a logger made here that writes nowhere.
 */
export function patchPino(exports: unknown, processor: TracepanelProcessor): void {
  const pino = (typeof exports === "function" ? exports : (exports as { default?: unknown })?.default) as
    | Pino
    | undefined;
  const symbols = pino?.symbols;
  if (typeof pino !== "function" || !symbols?.writeSym) return;
  const logger = pino({ level: "silent" }, { write() {} });
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(logger)) as object | null;
  if (!prototype || !Object.hasOwn(prototype, symbols.writeSym)) return;
  wrap(
    prototype,
    symbols.writeSym,
    (original) =>
      function (this: unknown, obj: unknown, msg: unknown, level: unknown, ...rest: unknown[]) {
        if (processor.current() && typeof level === "number") {
          processor.addLog(pinoRecord(this as PinoLogger, symbols, obj, msg, level));
        }
        return quietly(() => original.call(this, obj, msg, level, ...rest));
      },
  );
}

export class PinoLogs extends InstrumentationBase {
  constructor(private readonly processor: TracepanelProcessor) {
    super("tracepanel-pino", "1.0.0", {});
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition("pino", [">=8"], (exports) => {
      patchPino(exports, this.processor);
      return exports;
    });
  }
}

// winston

const LEVEL = Symbol.for("level");
const SPLAT = Symbol.for("splat");

// npm's levels (winston's default), syslog's and the cli's, by name: their numbers run the other way, and differ.
const WINSTON_LEVELS: { [name: string]: Log["level"] } = {
  emerg: "critical",
  alert: "critical",
  crit: "critical",
  fatal: "critical",
  error: "error",
  warn: "warning",
  warning: "warning",
  notice: "info",
  info: "info",
  http: "info",
  help: "info",
  data: "info",
  verbose: "debug",
  debug: "debug",
  input: "debug",
  prompt: "debug",
  silly: "debug",
  trace: "debug",
};

const WINSTON_FIELDS = new Set(["level", "message", "stack"]);

interface WinstonLogger {
  silent?: boolean;
  isLevelEnabled?(level: string): boolean;
}

interface Winston {
  Logger?: { prototype: object };
  transports?: { Console?: { prototype: object } };
}

/** The `%s` and the like in a message, which winston's splat format fills from the arguments after it. */
function placeholders(message: string): number {
  return (message.match(/%[sdifjoOc]/g) ?? []).length;
}

/** What the app handed winston: `info` as logger.write gets it, before the logger's formats. */
export function winstonRecord(info: Fields & { [LEVEL]?: unknown; [SPLAT]?: unknown }): LogRecord {
  const name = String(info[LEVEL] ?? info.level ?? "info");
  const error =
    info instanceof Error ? info : ((Object.values(info).find((value) => value instanceof Error) as Error) ?? null);
  const fields: Fields = { ...info };
  let message: unknown = info.message;
  const splat = info[SPLAT];
  if (typeof message === "string" && Array.isArray(splat) && placeholders(message) > 0) {
    const count = placeholders(message);
    message = format(message, ...splat.slice(0, count));
    // The object after the message's values is its fields, as winston's splat format takes it.
    for (const extra of splat.slice(count)) {
      if (extra && typeof extra === "object" && !(extra instanceof Error)) Object.assign(fields, extra);
    }
  }
  const stack = error?.stack ?? (typeof info.stack === "string" ? info.stack : null);
  const skip = new Set(WINSTON_FIELDS);
  for (const [key, value] of Object.entries(fields)) if (value === error) skip.add(key);
  return {
    time: Date.now() * 1000,
    level: WINSTON_LEVELS[name] ?? "info",
    logger: "winston",
    message: typeof message === "string" ? message : message === undefined ? "" : format(message),
    exception: stack,
    attrs: extraAttrs(fields, skip),
  };
}

/**
 * Every winston logger (createLogger's, a child's, the default one) hands each call to its write() as one `info`
 * object: wrapped, it records the call there, as the app made it, before the formats and whether or not a transport
 * takes it later. The Console transport prints through console when told to (forceConsole): not recorded again.
 */
export function patchWinston(exports: unknown, processor: TracepanelProcessor): void {
  const winston = exports as Winston & { default?: Winston };
  const Logger = winston.Logger ?? winston.default?.Logger;
  if (Logger?.prototype) {
    wrap(
      Logger.prototype,
      "write",
      (original) =>
        function (this: unknown, info: unknown, ...rest: unknown[]) {
          const logger = this as WinstonLogger;
          if (processor.current() && info && typeof info === "object" && !logger.silent) {
            const fields = info as Fields & { [LEVEL]?: unknown };
            const level = String(fields[LEVEL] ?? fields.level);
            if (typeof logger.isLevelEnabled !== "function" || logger.isLevelEnabled(level)) {
              processor.addLog(winstonRecord(fields));
            }
          }
          return quietly(() => original.call(this, info, ...rest));
        },
    );
  }
  const Console = (winston.transports ?? winston.default?.transports)?.Console;
  if (Console?.prototype) {
    wrap(
      Console.prototype,
      "log",
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          return quietly(() => original.apply(this, args));
        },
    );
  }
}

export class WinstonLogs extends InstrumentationBase {
  constructor(private readonly processor: TracepanelProcessor) {
    super("tracepanel-winston", "1.0.0", {});
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition("winston", [">=3"], (exports) => {
      patchWinston(exports, this.processor);
      return exports;
    });
  }
}
