import { readFileSync } from "node:fs";
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
});
