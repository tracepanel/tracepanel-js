// The CallSites of an error, kept as its stack is written: Error.prepareStackTrace becomes a hook that keeps them and
// returns exactly what the hook there before returns (an app's own, a source-map tool's, Node's), or V8's format.

import { afterEach, describe, expect, it, vi } from "vitest";

const prepare = Error.prepareStackTrace;

afterEach(() => {
  (Error as { prepareStackTrace?: unknown }).prepareStackTrace = prepare;
});

/** An error made here, on one line: each one's stack reads the same. */
function made(): Error {
  return new Error("boom");
}

/** The stack module, fresh: its hook not yet installed. */
async function stackModule() {
  vi.resetModules();
  return import("../src/stack.js");
}

describe("an error's CallSites", () => {
  it("are kept under the app's own prepareStackTrace, whose text is the stack's", async () => {
    const custom = (error: Error, sites: NodeJS.CallSite[]) =>
      `custom ${error.message}: ${sites[0]?.getFunctionName()}`;
    Error.prepareStackTrace = custom;
    const { errorSites, keepErrorSites } = await stackModule();
    keepErrorSites();
    const error = made();

    expect([error.stack, Error.prepareStackTrace === custom]).toEqual(["custom boom: made", false]);

    expect(errorSites(error, error.stack)?.[0]).toEqual({
      function: "made",
      file: new URL(import.meta.url).pathname,
      line: expect.any(Number),
      column: expect.any(Number),
      enclosing: { line: expect.any(Number), column: expect.any(Number) },
    });
  });

  it("are kept under the runtime's own, the stack's text as it was", async () => {
    const { errorSites, keepErrorSites } = await stackModule();
    // Two errors made at one place: one's stack written before the hook, the other's under it.
    const [first, error] = [0, 1].map(() => made()) as [Error, Error];
    const before = first.stack;
    keepErrorSites();

    expect(error.stack).toBe(before);
    expect(errorSites(undefined, error.stack)?.[0]?.function).toBe("made");
  });

  it("are kept with none there before: the stack as V8 writes it", async () => {
    const { errorSites, keepErrorSites } = await stackModule();
    (Error as { prepareStackTrace?: unknown }).prepareStackTrace = undefined;
    const [first, error] = [0, 1].map(() => made()) as [Error, Error];
    const before = first.stack;
    keepErrorSites();

    expect(error.stack).toBe(before);
    expect(errorSites(error, undefined)?.[0]?.function).toBe("made");
  });
});
