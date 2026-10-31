// A developer's own debug output, as the Python SDK records python-devtools' debug(): a dump the call tree always
// shows. console.dir() and console.table() are one, and so is console.log(), .debug() or .info() of anything that
// is not a primitive (an object, an array, a Map, a function): that is looking into a value, not a line of the
// app's log. Each argument is kept as Node prints it, with its type, its length and the source text it was given
// as, read from the call's line. Only the app's own calls are dumps; a library's stay log lines.

import { Console } from "node:console";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Writable } from "node:stream";
import { format, inspect } from "node:util";
import type { Log } from "./model.js";
import { MASK, sensitive } from "./request.js";
import { inApp, originOf, ownFile, parseStack, type StackFrame } from "./stack.js";

/** How long an argument's text is at most, "… (truncated)" included. */
export const MAX_REPR = 16_384;
const TRUNCATED = "… (truncated)";
// A string as long as the whole may be: inspect() cuts one at 10,000 characters.
const INSPECT = { depth: 6, compact: false, breakLength: 80, colors: false, maxStringLength: MAX_REPR } as const;
// A source file past this size isn't read for the arguments' text.
const MAX_SOURCE = 2_000_000;
// How far past the call's start its arguments are looked for, in characters.
const MAX_CALL = 20_000;

/** The console methods whose calls can be dumps. dir() and table() always are. */
export const DUMPING = new Set(["log", "debug", "info", "dir", "table"]);

export interface DumpArg {
  /** The argument's source text, or null: a literal, or a call whose source couldn't be read. */
  expr: string | null;
  repr: string;
  type: string;
  len: number | null;
}

/** Whether a call to a console method is a dump: dir(), table(), or a log of a value that isn't a primitive. */
export function isDump(method: string, args: readonly unknown[]): boolean {
  if (method === "dir" || method === "table") return args.length > 0;
  return DUMPING.has(method) && args.some(inspected);
}

/** A value that is looked into: an object or a function, not an Error (that is reported, as a log line's). */
function inspected(value: unknown): boolean {
  if (typeof value === "function") return true;
  return value !== null && typeof value === "object" && !(value instanceof Error);
}

/**
 * The dump of a console call, or null when the call isn't the app's own. `stack`: the stack at the call, the frames
 * of console's wrappers (this package's, a dev overlay's) above the app's.
 */
export function dump(
  method: string,
  args: readonly unknown[],
  stack: string | undefined,
  root: string,
): Omit<Log, "span_id"> | null {
  const site = callSite(stack);
  if (!site || !inApp(site.file, root)) return null;
  // dir() and table() print their first argument; the rest are how.
  const values = method === "dir" || method === "table" ? args.slice(0, 1) : args;
  const exprs = expressions(site, args.length);
  const dumped = values.map((value, index): DumpArg & { secret: boolean } => {
    const expr = exprs?.[index] ?? null;
    if (expr !== null && sensitive(expr)) return { expr, repr: MASK, type: typeOf(value), len: null, secret: true };
    const repr = reprOf(value);
    const literal = expr !== null && (expr === repr || (typeof value === "string" && /^["'`]/.test(expr)));
    return { expr: literal ? null : expr, repr, type: typeOf(value), len: lengthOf(value), secret: false };
  });
  const shown = args.map((value, index) => (dumped[index]?.secret ? MASK : value));
  return {
    time: Date.now() * 1000,
    level: "debug",
    logger: "console",
    message: printed(method, shown),
    exception: null,
    attrs: {
      "log.kind": "dump",
      "dump.lang": "javascript",
      "dump.args": dumped.map(({ expr, repr, type, len }) => ({ expr, repr, type, len })),
      "code.origin": originOf(site, root),
    },
  };
}

/** The frame that called console: the first that is neither this package's, Node's, nor another console wrapper. */
function callSite(stack: string | undefined): StackFrame | undefined {
  return parseStack(stack).find(
    (frame) => isAbsolute(frame.file) && !ownFile(frame.file) && !/^console\./i.test(frame.function),
  );
}

/** A value as Node's console prints it, cut at MAX_REPR. */
export function reprOf(value: unknown): string {
  let text: string;
  try {
    text = inspect(value, INSPECT);
  } catch {
    return `<unrepresentable ${typeof value}>`;
  }
  return text.length > MAX_REPR ? text.slice(0, MAX_REPR - TRUNCATED.length) + TRUNCATED : text;
}

/** A value's type: an object's constructor's name, a primitive's typeof. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object" && typeof value !== "function") return typeof value;
  try {
    const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
    return typeof name === "string" && name !== "" ? name : "Object";
  } catch {
    return "Object";
  }
}

/** An array's, a string's length, a Map's or Set's size; null for anything else. */
function lengthOf(value: unknown): number | null {
  try {
    if (typeof value === "string" || Array.isArray(value)) return value.length;
    if (ArrayBuffer.isView(value) && "length" in value) return Number(value.length);
    if (value instanceof Map || value instanceof Set) return value.size;
  } catch {
    // A proxy that throws: no length.
  }
  return null;
}

// What console would print, written here instead: a console of its own, without colors. Its stream takes each
// write at once, so the text is there when the call returns.
let output = "";
const sink = new Console({
  stdout: new Writable({
    decodeStrings: false,
    write(chunk: string, _encoding, done) {
      output += chunk;
      done();
    },
  }),
  colorMode: false,
});

/** The text a console method prints for these arguments, without its last newline. */
function printed(method: string, args: readonly unknown[]): string {
  output = "";
  try {
    (sink as unknown as Record<string, (...values: unknown[]) => void>)[method]?.(...args);
    return output.replace(/\n$/, "");
  } catch {
    return format(...args);
  } finally {
    output = "";
  }
}

/**
 * The source text of each argument of the call at a frame, read from its file; null when the file can't be read or
 * the call's arguments can't be told apart (a spread, a call split oddly, a line a bundler made).
 */
export function expressions(site: StackFrame, count: number): (string | null)[] | null {
  if (site.column === undefined || !Number.isFinite(site.column)) return null;
  try {
    if (statSync(site.file).size > MAX_SOURCE) return null;
    const lines = readFileSync(site.file, "utf8").split("\n");
    if (site.line < 1 || site.line > lines.length) return null;
    const text = lines
      .slice(site.line - 1)
      .join("\n")
      .slice(0, MAX_CALL + (lines[site.line - 1]?.length ?? 0));
    const start = site.column - 1;
    // The stack points at the call: `console.log(`, `log(`, `console.log?.(`; its parenthesis follows.
    const callee = /[\w$.?\s]*?\(/y;
    callee.lastIndex = start;
    if (!callee.exec(text)) return null;
    const found = argumentsAt(text, callee.lastIndex - 1);
    if (!found || found.length !== count || found.some((expr) => expr.startsWith("..."))) return null;
    return found;
  } catch {
    return null;
  }
}

/**
 * The arguments of the call whose parenthesis is at `open`, as source text without comments: strings, templates and
 * brackets kept whole.
 */
export function argumentsAt(text: string, open: number): string[] | null {
  const found: string[] = [];
  let arg = "";
  // The closing character each open bracket waits for; "`" while in a template literal's text.
  const closing: string[] = [")"];
  for (let at = open + 1; at < text.length; at++) {
    const char = text[at] ?? "";
    if (closing.at(-1) === "`") {
      if (char === "\\") {
        arg += text.slice(at, at + 2);
        at++;
        continue;
      }
      if (char === "`") closing.pop();
      else if (char === "$" && text[at + 1] === "{") {
        closing.push("}");
        arg += "${";
        at++;
        continue;
      }
      arg += char;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = stringEnd(text, at, char);
      if (end < 0) return null;
      arg += text.slice(at, end + 1);
      at = end;
    } else if (char === "/" && text[at + 1] === "/") {
      at = text.indexOf("\n", at);
      if (at < 0) return null;
      arg += "\n";
    } else if (char === "/" && text[at + 1] === "*") {
      at = text.indexOf("*/", at + 2);
      if (at < 0) return null;
      at++;
      arg += " ";
    } else if (char === "," && closing.length === 1) {
      found.push(arg);
      arg = "";
    } else if (char === ")" || char === "]" || char === "}") {
      if (closing.pop() !== char) return null;
      if (closing.length === 0) {
        found.push(arg);
        // An argument over several lines on one.
        const exprs = found.map((expr) => expr.trim().replace(/\s*\n\s*/g, " "));
        // A trailing comma, and a call without arguments.
        if (exprs.at(-1) === "") exprs.pop();
        return exprs;
      }
      arg += char;
    } else {
      if (char === "`") closing.push("`");
      else if (char === "(") closing.push(")");
      else if (char === "[") closing.push("]");
      else if (char === "{") closing.push("}");
      arg += char;
    }
  }
  return null;
}

/** Where a quoted string that opens at `open` closes, or -1 at the end of its line. */
function stringEnd(text: string, open: number, quote: string): number {
  for (let at = open + 1; at < text.length; at++) {
    const char = text[at];
    if (char === "\\") at++;
    else if (char === quote) return at;
    else if (char === "\n") return -1;
  }
  return -1;
}
