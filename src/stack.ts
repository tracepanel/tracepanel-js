// The app's own code in a V8 stack: where a query was made (code.origin), or the library code that asked for one
// none of the app's code made (code.caller); and an error's frames with their source.

import { existsSync, readFileSync, statSync } from "node:fs";
import nodeModule, { type SourceMap } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame } from "./model.js";

const CONTEXT_LINES = 5;
// "    at fn (file:line:col)", "    at file:line:col", "    at async fn (file:line:col)".
const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
// A line of a stack that is a frame, one per CallSite.
const AT = /^\s{4}at /;
// This package's own files are never the app's: its build, and its sources, where a runtime maps the build's frames
// back through its source maps (Bun does).
const OWN = fileURLToPath(new URL(".", import.meta.url));
const OWN_SOURCES = resolve(OWN, "..", "src") + sep;

/** Whether a file is this package's own. */
export function ownFile(file: string): boolean {
  return file.startsWith(OWN) || file.startsWith(OWN_SOURCES);
}

export interface StackFrame {
  function: string;
  file: string;
  line: number;
  /** 1-based, where the stack says it. */
  column?: number;
  /** Where the function that runs the frame starts, in the code that ran (a CallSite's), when it is known. */
  enclosing?: { line: number; column: number };
}

/**
 * The frames of a V8 stack, innermost first. `mapped`: a bundle's frames as the app's sources, through its source
 * map; without it, where the code that ran is, as the debugger sees it. `sites`: the stack's CallSites, one per line
 * (captured(), errorSites()): a frame is mapped from where its code ran and where its function starts, exactly,
 * though the stack's text was mapped already (Node's --enable-source-maps, a dev tool) or names a minifier's function.
 */
export function parseStack(
  stack: string | undefined,
  mapped = true,
  sites?: readonly (StackFrame | undefined)[],
): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = (stack ?? "").split("\n").filter((line) => AT.test(line));
  const aligned = sites !== undefined && sites.length === lines.length;
  for (const [index, line] of lines.entries()) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const [, fn, location, lineno, column] = match;
    const file = location?.startsWith("file://") ? fileURLToPath(location) : (location ?? "");
    const frame = { function: fn ?? "<anonymous>", file, line: Number(lineno), column: Number(column) };
    if (!mapped) {
      frames.push(frame);
      continue;
    }
    // The stack's name of the function (`Object.k`, `o.checkout`), mapped from the CallSite's place.
    const site = aligned ? sites[index] : undefined;
    const exact = site ? mappedFrame({ ...site, function: frame.function }) : undefined;
    frames.push(exact ?? original(frame, Number(column)));
  }
  return frames;
}

/** Whether a line of a V8 stack is an `async` one: a caller waiting for the frame above, not running under it. */
export function asyncFrames(stack: string | undefined): boolean[] {
  return (stack ?? "")
    .split("\n")
    .slice(1)
    .filter((line) => FRAME.test(line))
    .map((line) => /^\s*at async /.test(line));
}

// A dev server's bundle (`next dev`'s .next/dev/server/chunks/*.js, `nuxt dev`'s .nuxt/dev/index.mjs) runs the app's
// code: its frames are mapped back to the app's sources through the bundle's source map. The frames of a bundle
// without one are the bundler's glue, never the app's.
const BUNDLES = [`${sep}.next${sep}`, `${sep}.nuxt${sep}`, `${sep}.output${sep}`];
const MAPPING_URL = /\/\/[#@] sourceMappingURL=(\S+)\s*$/;

/** The source map a file's last sourceMappingURL comment names (an inline one may be longer than the code). */
function mappingUrl(text: string): string | undefined {
  const at = Math.max(text.lastIndexOf("//# sourceMappingURL="), text.lastIndexOf("//@ sourceMappingURL="));
  return at < 0 ? undefined : MAPPING_URL.exec(text.slice(at))?.[1];
}

/** A file's modification time and size, or "" for none: a cached map or source is read again once it changes. */
export function stampOf(file: string): string {
  try {
    const { mtimeMs, size } = statSync(file);
    return `${mtimeMs}:${size}`;
  } catch {
    return "";
  }
}

interface Cached {
  found: { map: SourceMap; at: string } | null;
  /** The code's lines, read once a frame's name is looked for in them. */
  lines?: string[] | null;
  /** The source's names of the frames' functions, by the stack's name and place. */
  names: Map<string, string>;
  /** The file's stamp, and its map file's when the map is one of its own, as they were read. */
  stamp: string;
  mapStamp: string;
}

/**
 * A file's source map and where it is (its sources are relative to it), or null: cached by the file's path, read
 * again once the file or its map file changes (a dev server rewrites a chunk under the same name).
 */
const maps = new Map<string, Cached>();

function sourceMap(file: string): { map: SourceMap; at: string } | null {
  const stamp = stampOf(file);
  const cached = maps.get(file);
  if (
    cached?.stamp === stamp &&
    (!cached.found || cached.found.at === file || cached.mapStamp === stampOf(cached.found.at))
  ) {
    return cached.found;
  }
  let found: { map: SourceMap; at: string } | null = null;
  try {
    // The map Node loaded with the file (--enable-source-maps), else the one its sourceMappingURL names (inline, or
    // a file), else the .map beside it.
    const loaded = nodeModule.findSourceMap?.(file);
    if (loaded) {
      found = { map: loaded, at: file };
    } else if (typeof nodeModule.SourceMap === "function") {
      const url = mappingUrl(readFileSync(file, "utf8"));
      let payload: string | undefined;
      let at = file;
      if (url?.startsWith("data:")) {
        const [meta, data = ""] = url.split(",", 2);
        payload = meta?.endsWith(";base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
      } else if (url) {
        at = url.startsWith("file://") ? fileURLToPath(url) : resolve(dirname(file), decodeURIComponent(url));
        payload = readFileSync(at, "utf8");
      } else if (existsSync(`${file}.map`)) {
        at = `${file}.map`;
        payload = readFileSync(at, "utf8");
      }
      if (payload !== undefined) found = { map: new nodeModule.SourceMap(JSON.parse(payload)), at };
    }
  } catch {
    // No map, or one that can't be read: the frame stays as it is.
  }
  maps.set(file, { found, stamp, mapStamp: found && found.at !== file ? stampOf(found.at) : "", names: new Map() });
  return found;
}

// A file past this size isn't read for its text (a source's lines, a bundle's names).
const MAX_SOURCE = 2_000_000;
const MAX_BUNDLE = 20_000_000;

/** The names already found for a bundle's frames, while its map is the one read. */
function cachedNames(file: string, found: { map: SourceMap; at: string }): Map<string, string> | undefined {
  const cached = maps.get(file);
  return cached?.found === found ? cached.names : undefined;
}

/** A bundle's lines, read once while its map is the one read; undefined for one too big or that can't be read. */
function generatedLines(file: string): string[] | undefined {
  const cached = maps.get(file);
  if (cached && cached.lines !== undefined) return cached.lines ?? undefined;
  let lines: string[] | null = null;
  try {
    if (statSync(file).size <= MAX_BUNDLE) lines = readFileSync(file, "utf8").split("\n");
  } catch {
    // Not readable: the stack's names stay.
  }
  if (cached) cached.lines = lines;
  return lines ?? undefined;
}

/** Source files read for their text, by path, as of their modification time and size: a dev server's edits read anew. */
const sources = new Map<string, { stamp: string; lines: string[] }>();
/** A source map's text of a source, split into lines once. */
const mappedLines = new Map<string, { text: string; lines: string[] }>();

/**
 * A source file's lines: as the source map that led to it holds them (what ran, though the file isn't on disk or
 * changed since), else read from the file; undefined for a file too big or that can't be read.
 */
export function sourceLines(file: string): string[] | undefined {
  const held = contents.get(file);
  if (held !== undefined) {
    if (held.length > MAX_SOURCE) return undefined;
    const split = mappedLines.get(file);
    if (split?.text === held) return split.lines;
    const lines = held.split("\n");
    mappedLines.set(file, { text: held, lines });
    return lines;
  }
  try {
    const { size, mtimeMs } = statSync(file);
    if (size > MAX_SOURCE) return undefined;
    const stamp = `${mtimeMs}:${size}`;
    const cached = sources.get(file);
    if (cached?.stamp === stamp) return cached.lines;
    const lines = readFileSync(file, "utf8").split("\n");
    sources.set(file, { stamp, lines });
    return lines;
  } catch {
    return undefined;
  }
}

/**
 * The text of the app's sources as their source maps hold it (sourcesContent), by path: what ran, though the file
 * changed since or isn't on disk (a bundle's virtual module).
 */
const contents = new Map<string, string>();

interface MapPayload {
  sources?: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  sections?: { map: MapPayload }[];
}

/** The sources each map was looked through for once: a bundle's map has thousands. A map read again is new. */
const looked = new WeakMap<object, Set<string>>();

/** Keep the text the map holds for the source at `path`, read from its sources (an index map's sections' too). */
function keepContent(map: SourceMap, mapFile: string, path: string): void {
  let paths = looked.get(map);
  if (!paths) {
    paths = new Set();
    looked.set(map, paths);
  }
  if (paths.has(path)) return;
  paths.add(path);
  // A map that holds no text of it (read again without it): the file is read, not an older map's text.
  if (!findContent(map.payload as MapPayload, mapFile, path)) contents.delete(path);
}

function findContent(payload: MapPayload, mapFile: string, path: string): boolean {
  const sourceRoot = String(payload.sourceRoot ?? "");
  for (const [index, source] of (payload.sources ?? []).entries()) {
    const content = payload.sourcesContent?.[index];
    if (typeof content === "string" && sourcePath(source, mapFile, sourceRoot) === path) {
      contents.set(path, content);
      return true;
    }
  }
  return (payload.sections ?? []).some((section) => findContent(section.map, mapFile, path));
}

/** A source map's name for a source, as a path: a file URL, Turbopack's [project]/, or relative to the map. */
function sourcePath(source: string, mapFile: string, sourceRoot: string): string {
  if (source.startsWith("file://")) return fileURLToPath(source);
  const project = /^(?:[\w-]+:\/\/\/?)?\[project\]\/(.*)$/.exec(source);
  if (project) {
    const bundle = BUNDLES.map((dir) => mapFile.indexOf(dir)).find((index) => index > 0);
    return resolve(bundle ? mapFile.slice(0, bundle) : process.cwd(), project[1] ?? "");
  }
  const webpack = /^webpack:\/\/[^/]*\/(.*)$/.exec(source);
  if (webpack) return resolve(process.cwd(), webpack[1] ?? "");
  return isAbsolute(source) ? source : resolve(dirname(mapFile), sourceRoot, source);
}

/**
 * Where a function is in the app's source, and its name there: a file URL or path, the line and column (1-based) where
 * it starts in the code that ran, and its name there (a profile's frame).
 */
export function place(url: string, line: number, column: number, name = ""): StackFrame {
  const file = url.startsWith("file://") ? fileURLToPath(url) : url;
  // This package's own code stays where it is: its source map leads out of it, to its TypeScript.
  if (ownFile(file)) return { function: name, file, line };
  return original({ function: name, file, line, enclosing: { line, column } }, column);
}

type Prepare = (error: Error, sites: NodeJS.CallSite[]) => unknown;

/**
 * A stack as the runtime would write it: the prepareStackTrace there before (a source-map tool's, Node's own on newer
 * versions, Vitest's), else V8's own format, which Node's is without source maps.
 */
function format(prepare: Prepare | undefined, error: Error, sites: NodeJS.CallSite[]): unknown {
  if (prepare) return prepare.call(Error, error, sites);
  let head: string;
  try {
    head = Error.prototype.toString.call(error);
  } catch {
    head = "Error";
  }
  return sites.length === 0 ? head : `${head}\n    at ${sites.join("\n    at ")}`;
}

/** The stack and its CallSites of the current place, `depth` frames deep, once: the global hook is put back at once. */
export function captured(depth: number): { stack: string | undefined; sites: (StackFrame | undefined)[] } {
  const previous = Error.prepareStackTrace as Prepare | undefined;
  const limit = Error.stackTraceLimit;
  let sites: NodeJS.CallSite[] = [];
  const holder: { stack?: unknown } = {};
  try {
    Error.stackTraceLimit = Math.max(limit, depth);
    Error.prepareStackTrace = (error, callSites) => {
      sites = callSites;
      // Through the app's own hook, not this package's (it would keep these too).
      return format(previous === hook ? inner : previous, error, callSites);
    };
    Error.captureStackTrace(holder, captured);
    void holder.stack;
  } catch {
    // A runtime without CallSites: the stack as it is.
  } finally {
    (Error as { prepareStackTrace?: unknown }).prepareStackTrace = previous;
    Error.stackTraceLimit = limit;
  }
  // A hook that writes no text (it hands back the CallSites): no stack to read.
  return typeof holder.stack === "string"
    ? { stack: holder.stack, sites: sites.map(siteFrame) }
    : { stack: undefined, sites: [] };
}

/** This package's prepareStackTrace while it records, and the one it runs inside it. */
let hook: Prepare | undefined;
let inner: Prepare | undefined;
/** The CallSites of the errors whose stack was written, by error. */
const ERROR_SITES = new WeakMap<object, NodeJS.CallSite[]>();
// The last stacks written, and their CallSites, for a span's exception event, which has only the stack's text: a ring
// a write only puts two references in, its text looked up when an error is recorded.
const MAX_STACKS = 256;
const ringStacks: unknown[] = new Array(MAX_STACKS);
const ringSites: (NodeJS.CallSite[] | undefined)[] = new Array(MAX_STACKS);
let ringAt = 0;

/**
 * Keep the CallSites of every error whose stack is written, for its frames: Error.prepareStackTrace becomes a hook
 * that keeps them and returns what the one there before returns (a source-map tool's, Node's own), or V8's format.
 * Not on an older Node with --enable-source-maps and no hook: its mapping can't be run from here. Once, while
 * Tracepanel records; a hook set later replaces it, and the frames are read from the stack's text again.
 */
export function keepErrorSites(): void {
  if (hook) return;
  const existing = Error.prepareStackTrace as Prepare | undefined;
  if (!existing && (process as { sourceMapsEnabled?: boolean }).sourceMapsEnabled) return;
  inner = existing;
  hook = function prepareStackTrace(error, sites) {
    const stack = format(inner, error, sites);
    if ((typeof error === "object" || typeof error === "function") && error !== null) ERROR_SITES.set(error, sites);
    ringStacks[ringAt] = stack;
    ringSites[ringAt] = sites;
    ringAt = (ringAt + 1) % MAX_STACKS;
    return stack;
  };
  Error.prepareStackTrace = hook;
}

/** The CallSites kept for an error, or for the stack it wrote, as frames; undefined when none were. */
export function errorSites(error: unknown, stack: string | undefined): (StackFrame | undefined)[] | undefined {
  const sites =
    ((typeof error === "object" || typeof error === "function") && error !== null
      ? ERROR_SITES.get(error)
      : undefined) ?? (stack ? ringSites[ringStacks.lastIndexOf(stack)] : undefined);
  return sites?.map(siteFrame);
}

function siteFrame(site: NodeJS.CallSite): StackFrame | undefined {
  const name = site.getFileName() ?? site.getScriptNameOrSourceURL?.();
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  if (!name || line === null || column === null) return undefined;
  const file = name.startsWith("file://") ? fileURLToPath(name) : name;
  const frame: StackFrame = { function: site.getFunctionName() ?? "<anonymous>", file, line, column };
  const at = site as NodeJS.CallSite & {
    getEnclosingLineNumber?(): number | null;
    getEnclosingColumnNumber?(): number | null;
  };
  const enclosingLine = at.getEnclosingLineNumber?.();
  const enclosingColumn = at.getEnclosingColumnNumber?.();
  if (enclosingLine && enclosingColumn) frame.enclosing = { line: enclosingLine, column: enclosingColumn };
  return frame;
}

/** A frame of the code that ran in the app's source, through this package's own reading of its source map. */
function mappedFrame(frame: StackFrame): StackFrame | undefined {
  const found = original(frame, frame.column ?? 1);
  return found === frame ? undefined : found;
}

/** The frame in the app's source, when its file is a bundle with a source map. */
function original(frame: StackFrame, column: number): StackFrame {
  if (!frame.file || !isAbsolute(frame.file) || frame.file.includes(`${sep}node_modules${sep}`)) return frame;
  const found = sourceMap(frame.file);
  if (!found) return frame;
  try {
    const entry = found.map.findEntry(frame.line - 1, Math.max(column - 1, 0));
    if (!("originalSource" in entry) || !entry.originalSource) return frame;
    const payload = found.map.payload as MapPayload;
    const file = sourcePath(entry.originalSource, found.at, String(payload.sourceRoot ?? ""));
    keepContent(found.map, found.at, file);
    return {
      function: originalName(frame, column, found),
      file,
      line: entry.originalLine + 1,
      column: entry.originalColumn + 1,
    };
  } catch {
    return frame;
  }
}

// How far up a bundle a function's or class's definition is looked for, in lines.
const MAX_LOOK_BACK = 5000;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const KEYWORDS = new Set(["function", "class", "async", "return", "new", "if", "for", "while", "switch", "catch"]);
// A stack's names that are no function or class of the app's.
const NOT_RENAMED = new Set(["Object", "Module", "<anonymous>", "async", "Promise", "Array"]);

/**
 * A frame's function as the source names it, where a minifier renamed it (`Object.k` -> `Object.placeOrder`,
 * `o.checkout` -> `Cart.checkout`): each name found where it is defined in the code that ran (the function's start a
 * CallSite gives, else its `function k`, `class o`, `k=` before the frame), and mapped there to the source's name
 * (the map's `names`, else the source's text there). A name not found stays as it is.
 */
function originalName(frame: StackFrame, column: number, found: { map: SourceMap; at: string }): string {
  const cached = cachedNames(frame.file, found);
  const key = `${frame.function}\0${frame.line}:${column}\0${frame.enclosing?.line}:${frame.enclosing?.column}`;
  const known = cached?.get(key);
  if (known !== undefined) return known;
  let name = frame.function;
  try {
    const lines = generatedLines(frame.file);
    if (lines) {
      const prefix = name.startsWith("new ") ? "new " : "";
      const parts = name.slice(prefix.length).split(".");
      const last = parts.length - 1;
      const renamed = parts.map((part, index) => {
        if (index === last && frame.enclosing) {
          const at = definitionAt(lines, frame.enclosing.line, frame.enclosing.column);
          const source = at && originalIdentifier(found, at.line, at.column);
          if (source) return source;
        }
        if (!IDENTIFIER.test(part) || NOT_RENAMED.has(part)) return part;
        const at = definitionBefore(lines, part, frame.line, column);
        return (at && originalIdentifier(found, at.line, at.column)) || part;
      });
      name = prefix + renamed.join(".");
    }
  } catch {
    // The name as the stack has it.
  }
  cached?.set(key, name);
  return name;
}

/** Where the function that starts at line:column (1-based) is named: `function k(`, a method's `k(`, `k=(…)=>`. */
function definitionAt(lines: string[], line: number, column: number): { line: number; column: number } | undefined {
  const text = lines[line - 1];
  if (text === undefined) return undefined;
  const at = column - 1;
  for (const pattern of [
    /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/y,
    /class\s+([A-Za-z_$][\w$]*)/y,
    /(?:(?:static|async|get|set)\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(/y,
  ]) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    const name = match?.[1];
    if (match && name && !KEYWORDS.has(name)) return { line, column: at + match[0].lastIndexOf(name) + 1 };
  }
  // An arrow or a function expression assigned: `k=(r)=>`, `k:function(`.
  const before = text.slice(Math.max(0, at - 200), at);
  const assigned = /([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s*)?$/.exec(before);
  if (assigned?.[1] && !KEYWORDS.has(assigned[1])) return { line, column: at - before.length + assigned.index + 1 };
  return undefined;
}

/** Where `name` is defined last before line:column: `function name(`, `class name`, `name=class`, `name=(`. */
function definitionBefore(
  lines: string[],
  name: string,
  line: number,
  column: number,
): { line: number; column: number } | undefined {
  const escaped = name.replace(/\$/g, "\\$");
  const pattern = new RegExp(
    `(?:\\bfunction\\s*\\*?\\s*|\\bclass\\s+)(${escaped})(?![\\w$])|(?<![\\w$.])(${escaped})\\s*=\\s*(?:class\\b|function\\b|async\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)`,
    "g",
  );
  for (let index = line - 1; index >= 0 && index >= line - MAX_LOOK_BACK; index--) {
    const text = index === line - 1 ? (lines[index] ?? "").slice(0, column - 1) : (lines[index] ?? "");
    let last: RegExpExecArray | undefined;
    for (const match of text.matchAll(pattern)) last = match;
    if (last) {
      const offset = last[1] !== undefined ? last[0].length - name.length : 0;
      return { line: index + 1, column: last.index + offset + 1 };
    }
  }
  return undefined;
}

/** The source's name of the identifier at line:column of the code that ran: the map's `names` entry, else its text. */
function originalIdentifier(found: { map: SourceMap; at: string }, line: number, column: number): string | undefined {
  const entry = found.map.findEntry(line - 1, column - 1) as {
    generatedLine?: number;
    generatedColumn?: number;
    originalSource?: string;
    originalLine?: number;
    originalColumn?: number;
    name?: string;
  };
  // Only a mapping of the identifier itself says its name.
  if (entry.generatedLine !== line - 1 || entry.generatedColumn !== column - 1 || !entry.originalSource)
    return undefined;
  if (entry.name && IDENTIFIER.test(entry.name)) return entry.name;
  const payload = found.map.payload as MapPayload;
  const file = sourcePath(entry.originalSource, found.at, String(payload.sourceRoot ?? ""));
  keepContent(found.map, found.at, file);
  const text = sourceLines(file)?.[entry.originalLine ?? -1]?.slice(entry.originalColumn ?? 0);
  if (text === undefined) return undefined;
  // The source's text there: the name, or the definition that starts there (`function placeOrder`, `const ship =`).
  const match =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|class\s+|(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)/.exec(
      text,
    );
  const name = match?.[1];
  return name && !KEYWORDS.has(name) ? name : undefined;
}

/** The project's own code: under the root, not a dependency, not a bundle, not Node's, not Tracepanel's. */
export function inApp(file: string, root: string): boolean {
  return (
    file.startsWith(root + sep) &&
    !file.includes(`${sep}node_modules${sep}`) &&
    !BUNDLES.some((dir) => file.startsWith(root + dir)) &&
    !ownFile(file) &&
    !file.startsWith("node:")
  );
}

// How deep origin() looks: a driver's span starts under a dozen frames of its own, the instrumentation's and
// Tracepanel's, more than V8's default 10.
const ORIGIN_DEPTH = 64;

/** `file:line in function` of the innermost frame of the app's own code on the current stack, or null. */
export function origin(root: string): string | null {
  return madeAt(root).origin;
}

// What makes a call rather than asks for one: the drivers, the ORMs and query builders on them, their pools, the
// instrumentation around them and the hooks that load it. Past these is the library code that wanted the call made
// (a session store, an admin panel, a job queue).
const CALL_LAYERS = new Set([
  "@opentelemetry",
  "@prisma",
  "@mikro-orm",
  "@redis",
  "@sequelize",
  "@tracepanel",
  "drizzle-orm",
  "generic-pool",
  "import-in-the-middle",
  "ioredis",
  "knex",
  "kysely",
  "mongodb",
  "mongoose",
  "mysql",
  "mysql2",
  "objection",
  "pg",
  "pg-cursor",
  "pg-pool",
  "pg-protocol",
  "prisma",
  "redis",
  "require-in-the-middle",
  "sequelize",
  "shimmer",
  "tarn",
  "tslib",
  "typeorm",
]);

// The ORMs and query builders a query goes through, by their package: what db.client names, as the Python SDK names
// Django's and SQLAlchemy's. The agent's N+1 hint is the ORM's own way to load the related rows.
const ORMS: Record<string, string> = {
  "@prisma": "prisma",
  "@sequelize": "sequelize",
  "drizzle-orm": "drizzle",
  knex: "knex",
  mongoose: "mongoose",
  sequelize: "sequelize",
  typeorm: "typeorm",
};

/** The installed package a file is in (pg, @prisma/client's scope @prisma), or null for a file in none. */
function packageOf(file: string): string | null {
  const at = file.lastIndexOf(`${sep}node_modules${sep}`);
  if (at < 0) return null;
  return file.slice(at + `${sep}node_modules${sep}`.length).split(sep)[0] ?? null;
}

/** Whether a frame is library code that may have asked for a call: not a driver's, Node's, Tracepanel's or glue. */
function asks(file: string, root: string): boolean {
  if (!isAbsolute(file) || ownFile(file)) return false;
  const name = packageOf(file);
  if (name !== null) return !CALL_LAYERS.has(name);
  // A bundle's frame that no source map led out of is the bundler's glue.
  return !BUNDLES.some((dir) => file.startsWith(root + dir));
}

/**
 * Where the call being made now was made. `origin`: `file:line in function` of the innermost frame of the app's own
 * code. Without one, `caller`: the library code that asked for it, the first frame past the driver, its ORM and
 * Tracepanel (`connect-pg-simple/index.js:… in PGStore.get`), as the Python SDK's code.caller names it. `orm`: the ORM
 * the call went through (`prisma`, `drizzle`), its innermost frame's, or null for a driver called directly.
 */
export function madeAt(root: string): { origin: string | null; caller: string | null; orm: string | null } {
  const { stack: text, sites } = captured(ORIGIN_DEPTH);
  const stack = parseStack(text, true, sites);
  const ormFrame = stack.find((frame) => ormOf(frame.file) !== null);
  const orm = ormFrame ? ormOf(ormFrame.file) : null;
  const own = stack.find((frame) => inApp(frame.file, root));
  if (own) {
    return { origin: originOf(own, root), caller: null, orm };
  }
  const asked = stack.find((frame) => asks(frame.file, root));
  return {
    origin: null,
    caller: asked ? `${libraryPath(asked.file)}:${asked.line} in ${shortName(asked.function)}` : null,
    orm,
  };
}

/** The ORM whose package a file is in, as db.client names it, or null. */
function ormOf(file: string): string | null {
  const name = packageOf(file);
  return name !== null && Object.hasOwn(ORMS, name) ? (ORMS[name] ?? null) : null;
}

/** `file:line in function` of a frame of the app's own code, the file relative to the project. */
export function originOf(frame: StackFrame, root: string): string {
  return `${relative(root, frame.file)}:${frame.line} in ${shortName(frame.function)}`;
}

function shortName(fn: string): string {
  return fn.replace(/^Object\.|^Module\./, "");
}

function sourceAround(file: string, line: number): { start: number | null; context: string[] } {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    const start = Math.max(line - CONTEXT_LINES, 1);
    return { start, context: lines.slice(start - 1, Math.min(line + CONTEXT_LINES, lines.length)) };
  } catch {
    return { start: null, context: [] };
  }
}

/**
 * An error's frames, outermost first as the console shows every SDK's, with the source of the app's own. `locals`:
 * the local variables of the app's frames, by the frame's place in the stack (innermost first), when they were read.
 * `error`: the error, whose CallSites were kept as its stack was written (keepErrorSites()), else its stack's.
 */
export function frames(
  stack: string | undefined,
  root: string,
  locals?: readonly (Record<string, string> | undefined)[],
  error?: unknown,
): Frame[] {
  return parseStack(stack, true, errorSites(error, stack))
    .map((frame, index) => {
      const own = inApp(frame.file, root);
      const { start, context } = own ? sourceAround(frame.file, frame.line) : { start: null, context: [] };
      return {
        filename: own ? relative(root, frame.file) : frame.file,
        module: "",
        function: shortName(frame.function),
        lineno: frame.line,
        in_app: own,
        context_start: start,
        context,
        locals: (own && locals?.[index]) || null,
      };
    })
    .reverse();
}

/** A library's file as its package names it (express/lib/router/index.js), Node's own as Node names them. */
export function libraryPath(file: string): string {
  const at = file.lastIndexOf(`${sep}node_modules${sep}`);
  return at >= 0 ? file.slice(at + `${sep}node_modules${sep}`.length) : file;
}
