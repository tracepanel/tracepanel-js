// A dump's source text in bundled or transpiled code (esbuild, tsc, a dev server's bundle): the call's place in the
// code that ran is mapped back to the app's source through the bundle's source map, wherever the map is (inline, the
// file its sourceMappingURL names, the .map beside it), and its arguments are read there, from the map's
// sourcesContent when it has it.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dump } from "../src/dumps.js";

const SOURCE = new URL("./app/debug.ts", import.meta.url);
const TSC = new URL("../node_modules/.bin/tsc", import.meta.url).pathname;
let root = "";

/** `src/debug.ts:<line> in <function>`: the line of the app's source with this comment. */
function origin(comment: string, fn: string): string {
  const lines = readFileSync(SOURCE, "utf8").split("\n");
  return `src/debug.ts:${lines.findIndex((text) => text.includes(`// ${comment}`)) + 1} in ${fn}`;
}

/** Bundle the app's source with esbuild, minified: its calls on one line, its variables renamed. */
function bundle(entry: string, out: string, sourcemap: "linked" | "inline" | "external"): void {
  buildSync({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    minify: true,
    sourcemap,
    logLevel: "silent",
  });
}

/** A V8 stack of a console.log() call at the code that ran: the place of the first match of `call` in `file`. */
function stackAt(file: string, call: RegExp, fn: string): string {
  const lines = readFileSync(file, "utf8").split("\n");
  const line = lines.findIndex((text) => call.test(text));
  const column = (lines[line] ?? "").search(call) + "console.".length + 1;
  return `Error\n    at ${fn} (${file}:${line + 1}:${column})\n    at handle (${join(root, "server.js")}:1:1)`;
}

/** The dump of `console.log(...args)` called where `stack` says. */
function dumped(args: unknown[], stack: string) {
  const found = dump("log", args, stack, root);
  return {
    exprs: ((found?.attrs["dump.args"] ?? []) as { expr: string | null; repr: string }[]).map(({ expr, repr }) => [
      expr,
      repr,
    ]),
    origin: found?.attrs["code.origin"],
    message: found?.message,
  };
}

// Minified, inspectOrder's call is console.log(o,o.items.length), withSecret's console.log("user:",{...},"s3cr3t").
const ORDER = /console\.log\((\w+),\1\.items\.length\)/;
const SECRET = /console\.log\("user:"/;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-maps-")));
  mkdirSync(join(root, "src"));
  copyFileSync(SOURCE, join(root, "src", "debug.ts"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a dump in bundled code", () => {
  it("reads the arguments in the source the bundle's map leads to: a map file its sourceMappingURL names", () => {
    const out = join(root, "dist", "linked.js");
    bundle(join(root, "src", "debug.ts"), out, "linked");

    expect(readFileSync(out, "utf8")).toContain("//# sourceMappingURL=linked.js.map");

    expect(dumped([{ id: 7 }, 2], stackAt(out, ORDER, "n"))).toEqual({
      exprs: [
        ["order", "{\n  id: 7\n}"],
        ["order.items.length", "2"],
      ],
      origin: origin("log", "n"),
      message: "{ id: 7 } 2",
    });

    expect(dumped(["user:", { name: "ann" }, "s3cr3t"], stackAt(out, SECRET, "r"))).toEqual({
      exprs: [
        [null, "'user:'"],
        ["user", "{\n  name: 'ann'\n}"],
        ["apiToken", "********"],
      ],
      origin: origin("secret", "r"),
      message: "user: { name: 'ann' } ********",
    });
  });

  it("reads an inline map, however long", () => {
    const out = join(root, "dist", "inline.js");
    bundle(join(root, "src", "debug.ts"), out, "inline");
    const code = readFileSync(out, "utf8");

    expect(code.length - code.indexOf("//# sourceMappingURL=data:")).toBeGreaterThan(2000);

    expect(dumped([{ id: 7 }, 2], stackAt(out, ORDER, "n"))).toEqual({
      exprs: [
        ["order", "{\n  id: 7\n}"],
        ["order.items.length", "2"],
      ],
      origin: origin("log", "n"),
      message: "{ id: 7 } 2",
    });
  });

  it("reads the .map beside a bundle that names none", () => {
    const out = join(root, "dist", "external.js");
    bundle(join(root, "src", "debug.ts"), out, "external");

    expect(readFileSync(out, "utf8")).not.toContain("sourceMappingURL");

    expect(dumped([{ id: 7 }, 2], stackAt(out, ORDER, "n")).exprs).toEqual([
      ["order", "{\n  id: 7\n}"],
      ["order.items.length", "2"],
    ]);
  });

  it("reads the source from the map's sourcesContent when the file isn't there", () => {
    mkdirSync(join(root, "gone"));
    copyFileSync(SOURCE, join(root, "gone", "debug.ts"));
    const out = join(root, "dist", "gone.js");
    bundle(join(root, "gone", "debug.ts"), out, "linked");
    rmSync(join(root, "gone"), { recursive: true });

    expect(dumped([{ id: 7 }, 2], stackAt(out, ORDER, "n"))).toEqual({
      exprs: [
        ["order", "{\n  id: 7\n}"],
        ["order.items.length", "2"],
      ],
      origin: origin("log", "n").replace("src/", "gone/"),
      message: "{ id: 7 } 2",
    });
  });
});

describe("a dump in transpiled code", () => {
  it("reads tsc's output through its .js.map, the source from the file", () => {
    execFileSync(TSC, [
      "--ignoreConfig",
      "--sourceMap",
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "--outDir",
      join(root, "tsc"),
      join(root, "src", "debug.ts"),
    ]);
    const out = join(root, "tsc", "debug.js");

    expect(readFileSync(`${out}.map`, "utf8")).not.toContain("sourcesContent");

    expect(dumped([{ id: 7 }, 2], stackAt(out, /console\.log\(order, order\.items\.length\)/, "inspectOrder"))).toEqual(
      {
        exprs: [
          ["order", "{\n  id: 7\n}"],
          ["order.items.length", "2"],
        ],
        origin: origin("log", "inspectOrder"),
        message: "{ id: 7 } 2",
      },
    );
  });

  it("reads a source again once it changed", () => {
    const file = join(root, "src", "edited.ts");
    const stack = `Error\n    at show (${file}:2:3)`;
    writeFileSync(file, "export function show(order) {\n  console.log(order);\n}\n");

    expect(dumped([{ id: 7 }], stack).exprs).toEqual([["order", "{\n  id: 7\n}"]]);

    writeFileSync(file, "export function show(cart) {\n  console.log(cart);\n}\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));

    expect(dumped([{ id: 7 }], stack).exprs).toEqual([["cart", "{\n  id: 7\n}"]]);
  });
});
