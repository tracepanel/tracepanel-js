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
}

/**
 * The frames of a V8 stack, innermost first. `mapped`: a bundle's frames as the app's sources, through its source
 * map; without it, where the code that ran is, as the debugger sees it.
 */
export function parseStack(stack: string | undefined, mapped = true): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const [, fn, location, lineno, column] = match;
    const file = location?.startsWith("file://") ? fileURLToPath(location) : (location ?? "");
    const frame = { function: fn ?? "<anonymous>", file, line: Number(lineno), column: Number(column) };
    frames.push(mapped ? original(frame, Number(column)) : frame);
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
  maps.set(file, { found, stamp, mapStamp: found && found.at !== file ? stampOf(found.at) : "" });
  return found;
}

/**
 * The text of the app's sources as their source maps hold it (sourcesContent), by path: what ran, though the file
 * changed since or isn't on disk (a bundle's virtual module).
 */
const contents = new Map<string, string>();

/** A source file's text as a source map that led to it holds it, when one did and holds it. */
export function mappedSource(file: string): string | undefined {
  return contents.get(file);
}

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

/** Where a function is in the app's source: a file URL or path and a line and column (1-based) of the code that ran. */
export function place(url: string, line: number, column: number): StackFrame {
  const file = url.startsWith("file://") ? fileURLToPath(url) : url;
  // This package's own code stays where it is: its source map leads out of it, to its TypeScript.
  return ownFile(file) ? { function: "", file, line } : original({ function: "", file, line }, column);
}

/**
 * The current stack, and the place in the code that ran of each of its lines: V8's CallSites, which no source map
 * changed (Node maps a stack with --enable-source-maps in its own prepareStackTrace only, a dev tool in its own). A
 * line the stack shows mapped to a source that isn't on disk is mapped here again from that place, where the map's
 * sourcesContent is at hand. The global prepareStackTrace is put back at once.
 */
export function stackWithSites(): { stack: string | undefined; sites: (StackFrame | undefined)[] } {
  const stack = new Error().stack;
  const previous = Error.prepareStackTrace;
  let sites: (StackFrame | undefined)[] = [];
  try {
    Error.prepareStackTrace = (_error, callSites) => callSites;
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder);
    if (Array.isArray(holder.stack)) sites = (holder.stack as NodeJS.CallSite[]).map(siteFrame);
  } catch {
    // A runtime without CallSites: the stack as it is.
  } finally {
    Error.prepareStackTrace = previous;
  }
  return { stack, sites };
}

function siteFrame(site: NodeJS.CallSite): StackFrame | undefined {
  const name = site.getFileName() ?? site.getScriptNameOrSourceURL?.();
  const line = site.getLineNumber();
  const column = site.getColumnNumber();
  if (!name || line === null || column === null) return undefined;
  const file = name.startsWith("file://") ? fileURLToPath(name) : name;
  return { function: site.getFunctionName() ?? "<anonymous>", file, line, column };
}

/** A frame of the code that ran in the app's source, through this package's own reading of its source map. */
export function mapped(frame: StackFrame): StackFrame | undefined {
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
    return { function: frame.function, file, line: entry.originalLine + 1, column: entry.originalColumn + 1 };
  } catch {
    return frame;
  }
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

/** The current stack, ORIGIN_DEPTH frames deep. */
function deepStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Math.max(limit, ORIGIN_DEPTH);
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

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
  const stack = parseStack(deepStack());
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
 */
export function frames(
  stack: string | undefined,
  root: string,
  locals?: readonly (Record<string, string> | undefined)[],
): Frame[] {
  return parseStack(stack)
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
