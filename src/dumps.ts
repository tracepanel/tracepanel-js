// A developer's own debug output, as the Python SDK records python-devtools' debug(): a dump the call tree always
// shows. console.dir() and console.table() are one, and so is console.log(), .debug() or .info() of anything that
// is not a primitive (an object, an array, a Map, a function): that is looking into a value, not a line of the
// app's log. Each argument is kept as Node prints it, with its type, its length and the source text it was given
// as, read from the call's line. Only the app's own calls are dumps; a library's stay log lines.

import { Console } from "node:console";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Writable } from "node:stream";
import { format, inspect, types } from "node:util";
import type { Log } from "./model.js";
import { MASK, sensitive } from "./request.js";
import { inApp, mappedSource, originOf, ownFile, parseStack, type StackFrame } from "./stack.js";

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
  // What is shown of each argument: its secrets masked, the keys that name one as the argument's own name does.
  const shown = args.map((value, index) => (exprs?.[index] && sensitive(exprs[index]) ? MASK : masked(value)));
  const dumped = values.map((value, index): DumpArg => {
    const expr = exprs?.[index] ?? null;
    if (expr !== null && sensitive(expr)) return { expr, repr: MASK, type: typeOf(value), len: null };
    const repr = reprOf(shown[index]);
    const literal = expr !== null && (expr === repr || (typeof value === "string" && /^["'`]/.test(expr)));
    return { expr: literal ? null : expr, repr, type: typeOf(value), len: lengthOf(value) };
  });
  return {
    time: Date.now() * 1000,
    level: "debug",
    logger: "console",
    message: printed(method, shown),
    exception: null,
    attrs: {
      "log.kind": "dump",
      "dump.lang": "javascript",
      "dump.args": dumped,
      "code.origin": originOf(site, root),
    },
  };
}

// How deep a value is looked into for secrets: past inspect()'s depth nothing is shown.
const MASK_DEPTH = INSPECT.depth + 1;
// An array's, a Map's or a Set's items inspect() shows: those past it aren't looked into.
const SHOWN_ITEMS = 100;

/** A key that names a secret: a string's, a symbol's description. */
function secretKey(key: unknown): boolean {
  if (typeof key === "string") return sensitive(key);
  return typeof key === "symbol" && key.description !== undefined && sensitive(key.description);
}

/** An object whose keys and items are looked into: not a proxy (its traps may do anything), a Date, a Buffer… */
function container(value: unknown): value is object {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  return (
    Array.isArray(value) ||
    value instanceof Map ||
    value instanceof Set ||
    !(
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer ||
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Error ||
      value instanceof Promise ||
      value instanceof WeakMap ||
      value instanceof WeakSet ||
      types.isBoxedPrimitive(value)
    )
  );
}

/** Whether a value holds a key that names a secret, as far as inspect() shows it. */
function holdsSecret(value: unknown, depth: number, seen: Set<object>): boolean {
  if (!container(value) || depth > MASK_DEPTH || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) {
    let index = 0;
    for (const [key, item] of value) {
      if (index++ >= SHOWN_ITEMS) break;
      if (secretKey(key) || holdsSecret(key, depth + 1, seen) || holdsSecret(item, depth + 1, seen)) return true;
    }
  } else if (value instanceof Set) {
    let index = 0;
    for (const item of value) {
      if (index++ >= SHOWN_ITEMS) break;
      if (holdsSecret(item, depth + 1, seen)) return true;
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (Array.isArray(value) && typeof key === "string" && Number(key) >= SHOWN_ITEMS) continue;
    if (secretKey(key)) return true;
    if ("value" in descriptor && holdsSecret(descriptor.value, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * A value as inspect() is to show it, a secret's value masked: a copy where an object's key, a class's field or a
 * Map's key names a secret (`password`, `apiToken`), with the same prototypes (inspect() names the class) and
 * cycles; the value itself when nothing in it does. The app's value is never changed, and no getter is called.
 */
export function masked(value: unknown): unknown {
  try {
    return holdsSecret(value, 0, new Set()) ? maskedCopy(value, 0, new Map()) : value;
  } catch {
    // A value that couldn't be looked into or copied: none of it is shown.
    return MASK;
  }
}

function maskedCopy(value: unknown, depth: number, copies: Map<object, unknown>): unknown {
  if (!container(value) || depth > MASK_DEPTH) return value;
  if (copies.has(value)) return copies.get(value);
  const inner = (item: unknown) => maskedCopy(item, depth + 1, copies);
  let copy: object;
  if (value instanceof Map) {
    const map = new Map();
    copy = map;
    copies.set(value, copy);
    let index = 0;
    for (const [key, item] of Map.prototype.entries.call(value)) {
      const shown = index++ < SHOWN_ITEMS;
      map.set(shown ? inner(key) : key, shown ? (secretKey(key) ? MASK : inner(item)) : item);
    }
  } else if (value instanceof Set) {
    const set = new Set();
    copy = set;
    copies.set(value, copy);
    let index = 0;
    for (const item of Set.prototype.values.call(value)) set.add(index++ < SHOWN_ITEMS ? inner(item) : item);
  } else {
    copy = Array.isArray(value) ? new Array(value.length) : {};
    copies.set(value, copy);
  }
  Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    // A getter stays one: inspect() shows [Getter] without calling it.
    if ("value" in descriptor) {
      const past = Array.isArray(value) && typeof key === "string" && Number(key) >= SHOWN_ITEMS;
      descriptor.value = secretKey(key) ? MASK : past ? descriptor.value : inner(descriptor.value);
    }
    Reflect.defineProperty(copy, key, descriptor);
  }
  return copy;
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

/** Source files read for the arguments' text, by path, as of their modification time: a dev server's edits read anew. */
const sources = new Map<string, { mtimeMs: number; lines: string[] }>();
/** A source map's text of a source, split into lines once. */
const mappedLines = new Map<string, { text: string; lines: string[] }>();

/**
 * A source file's lines: as the source map that led to it holds them (what ran, though the file isn't on disk or
 * changed since), else read from the file; undefined for a file too big or that can't be read.
 */
function sourceLines(file: string): string[] | undefined {
  const mapped = mappedSource(file);
  if (mapped !== undefined) {
    if (mapped.length > MAX_SOURCE) return undefined;
    const split = mappedLines.get(file);
    if (split?.text === mapped) return split.lines;
    const lines = mapped.split("\n");
    mappedLines.set(file, { text: mapped, lines });
    return lines;
  }
  const { size, mtimeMs } = statSync(file);
  if (size > MAX_SOURCE) return undefined;
  const cached = sources.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.lines;
  const lines = readFileSync(file, "utf8").split("\n");
  sources.set(file, { mtimeMs, lines });
  return lines;
}

/**
 * The source text of each argument of the call at a frame, read from its source (through its bundle's source map,
 * see stack.ts); null when the source can't be read or the call's arguments can't be told apart (a spread, a call
 * split oddly).
 */
export function expressions(site: StackFrame, count: number): (string | null)[] | null {
  if (site.column === undefined || !Number.isFinite(site.column)) return null;
  try {
    const lines = sourceLines(site.file);
    if (!lines) return null;
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
