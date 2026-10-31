// A developer's own debug output, as the Python SDK records python-devtools' debug(): a dump the call tree always
// shows. console.dir() and console.table() are one, and so is console.log(), .debug() or .info() of anything that
// is not a primitive (an object, an array, a Map, a function): that is looking into a value, not a line of the
// app's log. Each argument is kept as Node prints it, with its type, its length and the source text it was given
// as, read from the call's line. Only the app's own calls are dumps; a library's stay log lines.

import { Console } from "node:console";
import { isAbsolute } from "node:path";
import { Writable } from "node:stream";
import { format, inspect, types } from "node:util";
import type { Log } from "./model.js";
import { MASK, sensitive } from "./request.js";
import { inApp, mapped, originOf, ownFile, parseStack, type StackFrame, sourceLines } from "./stack.js";

/** How long an argument's text is at most, "… (truncated)" included. */
export const MAX_REPR = 16_384;
const TRUNCATED = "… (truncated)";
// A string as long as the whole may be: inspect() cuts one at 10,000 characters.
const INSPECT = { depth: 6, compact: false, breakLength: 80, colors: false, maxStringLength: MAX_REPR } as const;
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
  if (typeof value === "function" || proxy(value)) return true;
  return value !== null && typeof value === "object" && !(value instanceof Error);
}

/** A proxy: looked at without its traps (instanceof and property reads would run them), as inspect() does. */
function proxy(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && types.isProxy(value);
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
  sites?: readonly (StackFrame | undefined)[],
): Omit<Log, "span_id"> | null {
  const site = callSite(stack, sites);
  if (!site || !inApp(site.file, root)) return null;
  // dir() and table() print their first argument; the rest are how.
  const values = method === "dir" || method === "table" ? args.slice(0, 1) : args;
  const exprs = expressions(site, args.length);
  // What is shown of each argument: its secrets masked, the keys that name one as the argument's own name does.
  const shown = args.map((value, index): Shown & { text: string } => {
    if (exprs?.[index] && sensitive(exprs[index])) return { value: MASK, byText: false, text: MASK };
    const copy = masked(value);
    const text = inspectedText(copy.value);
    if (text !== undefined) return { ...copy, text: copy.byText ? maskText(text) : text };
    // The copy can't be shown (a class's inspect that reads its #private fields): the value is, its text masked.
    const own = inspectedText(value);
    return { value, byText: true, text: own === undefined ? `<unrepresentable ${typeof value}>` : maskText(own) };
  });
  const dumped = values.map((value, index): DumpArg => {
    const expr = exprs?.[index] ?? null;
    if (expr !== null && sensitive(expr)) return { expr, repr: MASK, type: typeOf(value), len: null };
    const repr = cut(shown[index]?.text ?? "");
    const literal = expr !== null && (expr === repr || (typeof value === "string" && /^["'`]/.test(expr)));
    return { expr: literal ? null : expr, repr, type: typeOf(value), len: lengthOf(value) };
  });
  const byText = shown.some((arg) => arg.byText);
  const shownValues = shown.map((arg) => arg.value);
  return {
    time: Date.now() * 1000,
    level: "debug",
    logger: "console",
    // Masked by its text: as console.log() prints it (a table would read a proxy through its traps).
    message: byText
      ? maskText(printed(method === "table" ? "log" : method, shownValues))
      : printed(method, shownValues),
    exception: null,
    attrs: {
      "log.kind": "dump",
      "dump.lang": "javascript",
      "dump.args": dumped,
      "code.origin": originOf(site, root),
    },
  };
}

/**
 * The frame that called console: the first that is neither this package's, Node's, nor another console wrapper.
 * `sites`: where each line of the stack is in the code that ran (stackWithSites()); a line mapped here, through
 * the bundle's source map, has the source's text at hand even where the stack was mapped already (Node's
 * --enable-source-maps) to a file that isn't on disk.
 */
function callSite(stack: string | undefined, sites?: readonly (StackFrame | undefined)[]): StackFrame | undefined {
  const lines = (stack ?? "").split("\n").slice(1);
  const aligned = sites?.length === lines.length;
  for (const [index, line] of lines.entries()) {
    const frame = parseStack(`Error\n${line}`)[0];
    if (!frame || !isAbsolute(frame.file) || ownFile(frame.file) || /^console\./i.test(frame.function)) continue;
    const ran = aligned ? sites?.[index] : undefined;
    // The stack's name of the function (`Object.k`, `o.checkout`), in the source's names as the map has them.
    const ours = ran ? mapped({ ...ran, function: frame.function }) : undefined;
    return ours ?? frame;
  }
  return undefined;
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

/** What looking into a value found: a key that names a secret, a proxy (not looked into: its text is masked). */
interface Found {
  secret: boolean;
  proxy: boolean;
}

/** Look for keys that name a secret in a value, as far as inspect() shows it, and for proxies. */
function lookInto(value: unknown, depth: number, seen: Set<object>, found: Found): void {
  if (proxy(value)) found.proxy = true;
  if (!container(value) || depth > MASK_DEPTH || seen.has(value)) return;
  seen.add(value);
  const inner = (item: unknown) => lookInto(item, depth + 1, seen, found);
  if (value instanceof Map) {
    let index = 0;
    for (const [key, item] of Map.prototype.entries.call(value)) {
      if (index++ >= SHOWN_ITEMS) break;
      if (secretKey(key)) found.secret = true;
      inner(key);
      inner(item);
    }
  } else if (value instanceof Set) {
    let index = 0;
    for (const item of Set.prototype.values.call(value)) {
      if (index++ >= SHOWN_ITEMS) break;
      inner(item);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (Array.isArray(value) && typeof key === "string" && Number(key) >= SHOWN_ITEMS) continue;
    if (secretKey(key)) found.secret = true;
    if ("value" in descriptor) inner(descriptor.value);
  }
}

/** What a dump shows of a value: a copy with its secrets masked, or the value; `byText`: its text is to be masked. */
export interface Shown {
  value: unknown;
  byText: boolean;
}

/**
 * A value as inspect() is to show it, a secret's value masked: a copy where an object's key, a class's field or a
 * Map's key names a secret (`password`, `apiToken`), with the same prototypes (inspect() names the class) and
 * cycles; the value itself when nothing in it does. The app's value is never changed, and no getter is called. A
 * proxy isn't looked into (its traps could run anything): inspect() shows its target without them, and that text is
 * masked (maskText()).
 */
export function masked(value: unknown): Shown {
  try {
    const found: Found = { secret: false, proxy: false };
    lookInto(value, 0, new Set(), found);
    return { value: found.secret ? maskedCopy(value, 0, new Map()) : value, byText: found.proxy };
  } catch {
    // A value that couldn't be looked into or copied: its text is masked.
    return { value, byText: true };
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

/** A value as Node's console prints it, cut at MAX_REPR. */
export function reprOf(value: unknown): string {
  const text = inspectedText(value);
  return text === undefined ? `<unrepresentable ${typeof value}>` : cut(text);
}

/** A value as inspect() shows it, or undefined when that throws. */
function inspectedText(value: unknown): string | undefined {
  try {
    return inspect(value, INSPECT);
  } catch {
    return undefined;
  }
}

/** A text cut at MAX_REPR. */
function cut(text: string): string {
  return text.length > MAX_REPR ? text.slice(0, MAX_REPR - TRUNCATED.length) + TRUNCATED : text;
}

// A key as inspect() prints it before its value: `apiKey: `, `'api-key': `, `[Symbol(token)]: `, a Map's `'token' => `.
const PRINTED_KEY =
  /(^|[\s{,([])(?:([A-Za-z_$][\w$-]*)|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\[Symbol\(([^)\n]*)\)\])(: | => )/g;
// `name=value` in a text (a query string, a DSN, a cookie).
const ASSIGNED = /(^|[^\w$])([A-Za-z_$][\w$-]*)=(?![=>])([^\s&;,'"`)\]}]+)/g;

/**
 * A text inspect() made with every value under a key that names a secret masked: a quoted string (over several
 * lines too), an object or array to its closing bracket, `[Getter]`, a number; and `name=value` pairs. What is masked
 * reads `'********'`.
 */
export function maskText(text: string): string {
  let out = "";
  let from = 0;
  PRINTED_KEY.lastIndex = 0;
  for (let match = PRINTED_KEY.exec(text); match; match = PRINTED_KEY.exec(text)) {
    const name = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    if (!sensitive(name)) continue;
    const start = match.index + match[0].length;
    const end = valueEnd(text, start);
    out += `${text.slice(from, start)}'${MASK}'`;
    from = end;
    PRINTED_KEY.lastIndex = Math.max(end, start);
  }
  out += text.slice(from);
  return out.replace(ASSIGNED, (whole, before: string, name: string) =>
    sensitive(name) ? `${before}${name}=${MASK}` : whole,
  );
}

/** Where the value inspect() printed at `at` ends. */
function valueEnd(text: string, at: number): number {
  let index = at;
  const quote = text[index];
  if (quote === "'" || quote === '"' || quote === "`") {
    for (;;) {
      index = quotedEnd(text, index);
      // A string over several lines: `'a\n' +` and the next part on the next line.
      const more = /^ \+\n\s*(?=['"`])/.exec(text.slice(index, index + 200));
      if (!more) return index;
      index += more[0].length;
    }
  }
  // A class's name, `Map(2)`, `<ref *1>`, `[Object: null prototype]` before its brackets, or a bare value.
  while (index < text.length) {
    const char = text[index];
    if (char === "{" || char === "[") {
      index = bracketEnd(text, index);
      if (!/^ [{[]/.test(text.slice(index, index + 2))) return index;
      index++;
    } else if (char === "," || char === "\n" || char === "}" || char === "]" || char === ")") {
      // The space before a closing bracket isn't the value's.
      while (index > at && text[index - 1] === " ") index--;
      return index;
    } else {
      index++;
    }
  }
  return index;
}

/** Where the quoted string that opens at `open` ends (past its quote). */
function quotedEnd(text: string, open: number): number {
  const quote = text[open];
  let index = open + 1;
  while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1;
  return Math.min(index + 1, text.length);
}

/** Where the bracket that opens at `open` closes (past it), strings inside skipped. */
function bracketEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      index = quotedEnd(text, index) - 1;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/** A value's type: an object's constructor's name, a primitive's typeof. */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object" && typeof value !== "function") return typeof value;
  if (proxy(value)) return "Proxy";
  try {
    const name: unknown = Object.getPrototypeOf(value)?.constructor?.name;
    return typeof name === "string" && name !== "" ? name : "Object";
  } catch {
    return "Object";
  }
}

/** An array's, a string's length, a Map's or Set's size; null for anything else. */
function lengthOf(value: unknown): number | null {
  if (proxy(value)) return null;
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
