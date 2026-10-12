// The app's own code in a V8 stack: where a query was made (code.origin), and an error's frames with their source.

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame } from "./model.js";

const CONTEXT_LINES = 5;
// "    at fn (file:line:col)", "    at file:line:col", "    at async fn (file:line:col)".
const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
// This package's own files are never the app's.
const OWN = fileURLToPath(new URL(".", import.meta.url));

export interface StackFrame {
  function: string;
  file: string;
  line: number;
}

export function parseStack(stack: string | undefined): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    const [, fn, location, lineno] = match;
    const file = location?.startsWith("file://") ? fileURLToPath(location) : (location ?? "");
    frames.push({ function: fn ?? "<anonymous>", file, line: Number(lineno) });
  }
  return frames;
}

/** The project's own code: under the root, not a dependency, not Node's, not Tracepanel's. */
export function inApp(file: string, root: string): boolean {
  return (
    file.startsWith(root + sep) &&
    !file.includes(`${sep}node_modules${sep}`) &&
    !file.startsWith(OWN) &&
    !file.startsWith("node:")
  );
}

/** `file:line in function` of the innermost frame of the app's own code on the current stack, or null. */
export function origin(root: string): string | null {
  const frame = parseStack(new Error().stack).find((candidate) => inApp(candidate.file, root));
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

/** An error's frames, outermost first as the console shows every SDK's, with the source of the app's own. */
export function frames(stack: string | undefined, root: string): Frame[] {
  return parseStack(stack)
    .map((frame) => {
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
        locals: {},
      };
    })
    .reverse();
}
