// The app's own code in a V8 stack: where a query was made (code.origin), and an error's frames with their source.

import { readFileSync } from "node:fs";
import nodeModule, { type SourceMap } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame } from "./model.js";

const CONTEXT_LINES = 5;
// "    at fn (file:line:col)", "    at file:line:col", "    at async fn (file:line:col)".
const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
// This package's own files are never the app's.
const OWN = fileURLToPath(new URL(".", import.meta.url));

/** Whether a file is this package's own. */
export function ownFile(file: string): boolean {
  return file.startsWith(OWN);
}

export interface StackFrame {
  function: string;
  file: string;
  line: number;
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
    const frame = { function: fn ?? "<anonymous>", file, line: Number(lineno) };
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

/** A file's source map and where it is (its sources are relative to it), or null: cached by the file's path. */
const maps = new Map<string, { map: SourceMap; at: string } | null>();

function sourceMap(file: string): { map: SourceMap; at: string } | null {
  if (maps.has(file)) return maps.get(file) ?? null;
  let found: { map: SourceMap; at: string } | null = null;
  try {
    // The map Node loaded with the file (--enable-source-maps), else the one its sourceMappingURL names.
    const loaded = nodeModule.findSourceMap?.(file);
    if (loaded) {
      found = { map: loaded, at: file };
    } else {
      const text = readFileSync(file, "utf8");
      const url = MAPPING_URL.exec(text.slice(-2000))?.[1];
      if (url && typeof nodeModule.SourceMap === "function") {
        let payload: string;
        let at = file;
        if (url.startsWith("data:")) {
          const [meta, data = ""] = url.split(",", 2);
          payload = meta?.endsWith(";base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
        } else {
          at = url.startsWith("file://") ? fileURLToPath(url) : resolve(dirname(file), decodeURIComponent(url));
          payload = readFileSync(at, "utf8");
        }
        found = { map: new nodeModule.SourceMap(JSON.parse(payload)), at };
      }
    }
  } catch {
    // No map, or one that can't be read: the frame stays as it is.
  }
  maps.set(file, found);
  return found;
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

/** The frame in the app's source, when its file is a bundle with a source map. */
function original(frame: StackFrame, column: number): StackFrame {
  if (!frame.file || !isAbsolute(frame.file) || frame.file.includes(`${sep}node_modules${sep}`)) return frame;
  const found = sourceMap(frame.file);
  if (!found) return frame;
  try {
    const entry = found.map.findEntry(frame.line - 1, Math.max(column - 1, 0));
    if (!("originalSource" in entry) || !entry.originalSource) return frame;
    const sourceRoot = String((found.map.payload as { sourceRoot?: string }).sourceRoot ?? "");
    return {
      function: frame.function,
      file: sourcePath(entry.originalSource, found.at, sourceRoot),
      line: entry.originalLine + 1,
    };
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
    !file.startsWith(OWN) &&
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
  const frame = parseStack(deepStack()).find((candidate) => inApp(candidate.file, root));
  return frame ? `${relative(root, frame.file)}:${frame.line} in ${shortName(frame.function)}` : null;
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
