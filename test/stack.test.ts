import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { frames, inApp, origin, parseStack } from "../src/stack.js";
import { underLibrary } from "./app/shop.js";

const STACK = `Error: boom
    at listBooks (/app/src/books.js:12:9)
    at async /app/node_modules/express/lib/router.js:40:3
    at file:///app/src/server.mjs:25:5
    at node:internal/process/task_queues:105:5`;

describe("stack", () => {
  it("reads V8 frames, file URLs included", () => {
    expect(parseStack(STACK).map((frame) => [frame.function, frame.file, frame.line])).toEqual([
      ["listBooks", "/app/src/books.js", 12],
      ["<anonymous>", "/app/node_modules/express/lib/router.js", 40],
      ["<anonymous>", "/app/src/server.mjs", 25],
      ["<anonymous>", "node:internal/process/task_queues", 105],
    ]);
  });

  it("counts only the project's own code as the app's", () => {
    expect(inApp("/app/src/books.js", "/app")).toBe(true);
    expect(inApp("/app/node_modules/express/lib/router.js", "/app")).toBe(false);
    expect(inApp("/elsewhere/x.js", "/app")).toBe(false);
  });

  it("gives an error's frames outermost first, paths relative to the project", () => {
    const result = frames(STACK, "/app");
    expect(result.map((frame) => [frame.filename, frame.in_app])).toEqual([
      ["node:internal/process/task_queues", false],
      ["src/server.mjs", true],
      ["/app/node_modules/express/lib/router.js", false],
      ["src/books.js", true],
    ]);
  });

  it("finds the app's line under a library's deep stack", () => {
    const app = new URL("./app/", import.meta.url);
    const deep = (depth: number): string | null => (depth === 0 ? origin(app.pathname.slice(0, -1)) : deep(depth - 1));
    const lines = readFileSync(new URL("shop.ts", app), "utf8").split("\n");

    expect(underLibrary(() => deep(30))).toBe(
      `shop.ts:${lines.findIndex((text) => text.includes("// library")) + 1} in underLibrary`,
    );
  });

  describe("in a dev server's bundle", () => {
    // A project as `next dev` (Turbopack) and `nuxt dev` (Nitro) leave it: the server's code bundled, with its maps.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-maps-")));
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const source = Array.from({ length: 12 }, (_, index) => `// line ${index + 1}`).join("\n");
    write("app/api/route.ts", source);
    write("server/api/books.ts", source);
    write(".next/dev/server/chunks/app.js", "GET();\nhandle();\n//# sourceMappingURL=app.js.map\n");
    // Line 1 is the route's line 10, line 2 a dependency's line 3. Turbopack names its sources by file URL.
    write(
      ".next/dev/server/chunks/app.js.map",
      JSON.stringify({
        version: 3,
        sources: [`file://${root}/app/api/route.ts`, `file://${root}/node_modules/lib/index.ts`],
        names: [],
        mappings: "AASA;ACPA",
      }),
    );
    write(".next/dev/server/chunks/plain.js", "glue();\n");
    // Nitro's sources are relative to its map: line 1 is the handler's line 3.
    write(".nuxt/dev/index.mjs", "handler();\n//# sourceMappingURL=index.mjs.map\n");
    write(
      ".nuxt/dev/index.mjs.map",
      JSON.stringify({ version: 3, sources: ["../../server/api/books.ts"], names: [], mappings: "AAEA" }),
    );
    const stack = [
      "Error: boom",
      `    at GET (${root}/.next/dev/server/chunks/app.js:1:1)`,
      `    at handle (${root}/.next/dev/server/chunks/app.js:2:1)`,
      `    at handler (file://${root}/.nuxt/dev/index.mjs:1:1)`,
      `    at glue (${root}/.next/dev/server/chunks/plain.js:1:1)`,
    ].join("\n");

    it("reads each frame where its source map points", () => {
      expect(parseStack(stack).map((frame) => [frame.function, frame.file, frame.line])).toEqual([
        ["GET", `${root}/app/api/route.ts`, 10],
        ["handle", `${root}/node_modules/lib/index.ts`, 3],
        ["handler", `${root}/server/api/books.ts`, 3],
        ["glue", `${root}/.next/dev/server/chunks/plain.js`, 1],
      ]);
    });

    it("counts the app's sources as its code, not the dependencies or the bundle's own glue", () => {
      expect(frames(stack, root).map((frame) => [frame.filename, frame.lineno, frame.in_app])).toEqual([
        [`${root}/.next/dev/server/chunks/plain.js`, 1, false],
        ["server/api/books.ts", 3, true],
        [`${root}/node_modules/lib/index.ts`, 3, false],
        ["app/api/route.ts", 10, true],
      ]);

      expect(frames(stack, root).at(-1)?.context).toEqual(source.split("\n").slice(4, 12));
    });
  });
});
