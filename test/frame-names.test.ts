// A minified bundle's function names in the app's source's names: a dump's code.origin, a stack's frames and a
// profile's frames name `placeOrder`, `Cart.checkout`, `shipOrder`, not the minifier's `l`, `o.checkout`, `k`.
// biome-ignore-all lint/suspicious/noConsole: the terminal's console method, swapped and put back.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { captureConsole } from "../src/console.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";
import { parseStack, place } from "../src/stack.js";

const SOURCE = new URL("./app/names.ts", import.meta.url);
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
let root = "";
let out = "";
let app: {
  placeOrder(total: number): Error;
  Cart: new () => { checkout(): Error };
  shipOrder(id: number): Error;
};
const log = console.log;

/** `src/names.ts:<line>`: the line of the source with this comment. */
function line(comment: string): string {
  const lines = readFileSync(SOURCE, "utf8").split("\n");
  return `src/names.ts:${lines.findIndex((text) => text.includes(`// ${comment}`)) + 1}`;
}

/** The ways the app's functions are called, each giving back its error. */
const CALLS: [string, () => Error][] = [
  ["placeOrder", () => app.placeOrder(5)],
  ["checkout", () => new app.Cart().checkout()],
  ["shipOrder", () => app.shipOrder(7)],
];

/** V8's CallSites of an error, read before its stack was ever formatted. */
function callSites(error: Error): NodeJS.CallSite[] {
  const previous = Error.prepareStackTrace;
  Error.prepareStackTrace = (_error, sites) => sites;
  try {
    return error.stack as unknown as NodeJS.CallSite[];
  } finally {
    Error.prepareStackTrace = previous;
  }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-names-")));
  mkdirSync(join(root, "src"));
  copyFileSync(SOURCE, join(root, "src", "names.ts"));
  out = join(root, "dist", "names.cjs");
  buildSync({
    entryPoints: [join(root, "src", "names.ts")],
    outfile: out,
    bundle: true,
    format: "cjs",
    platform: "node",
    minify: true,
    sourcemap: "linked",
    logLevel: "silent",
  });
  app = createRequire(import.meta.url)(out);
  console.log = () => undefined;
});

afterAll(() => {
  console.log = log;
  manager.disable();
  rmSync(root, { recursive: true, force: true });
});

describe("a minified bundle's functions", () => {
  it("are renamed in the bundle", () => {
    const code = readFileSync(out, "utf8");

    expect([code.includes("function placeOrder"), code.includes("class Cart"), code.includes("shipOrder=")]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("name a dump's code.origin as the source does", async () => {
    const config: Config = { ...loadConfig({}), enabled: true, root, service: "shop" };
    const sent: Trace[] = [];
    const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
    const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("test");
    captureConsole(processor, config);
    const span = tracer.startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "GET", "url.path": "/orders" },
    });
    context.with(trace.setSpan(context.active(), span), () => {
      for (const [, call] of CALLS) call();
    });
    span.end();
    await new Promise((done) => setTimeout(done, 60));

    expect(sent.at(-1)?.logs.map((entry) => entry.attrs["code.origin"])).toEqual([
      `${line("placeOrder")} in placeOrder`,
      `${line("checkout")} in Cart.checkout`,
      `${line("shipOrder")} in shipOrder`,
    ]);
  });

  it("name a stack's frames as the source does", () => {
    expect(CALLS.map(([, call]) => parseStack(call().stack)[0]?.function)).toEqual([
      expect.stringMatching(/^(Object\.)?placeOrder$/),
      "Cart.checkout",
      expect.stringMatching(/^(Object\.)?shipOrder$/),
    ]);
  });

  it("are named from the source's text where the map has no names", () => {
    const bare = join(root, "dist", "bare.cjs");
    const map = JSON.parse(readFileSync(`${out}.map`, "utf8")) as { names: string[] };
    writeFileSync(`${bare}.map`, JSON.stringify({ ...map, names: map.names.map(() => "") }));
    writeFileSync(
      bare,
      readFileSync(out, "utf8").replace("sourceMappingURL=names.cjs.map", "sourceMappingURL=bare.cjs.map"),
    );

    // The same code under another name: the stacks of the bundle, at the copy's path.
    expect(CALLS.map(([, call]) => parseStack(call().stack?.replaceAll(out, bare))[0]?.function)).toEqual([
      expect.stringMatching(/^(Object\.)?placeOrder$/),
      "Cart.checkout",
      expect.stringMatching(/^(Object\.)?shipOrder$/),
    ]);
  });

  it("name a profile's frames, by where each function starts, as the source does", () => {
    expect(
      CALLS.map(([, call]) => {
        const site = callSites(call())[0] as NodeJS.CallSite;
        const at = place(
          out,
          site.getEnclosingLineNumber() ?? 0,
          site.getEnclosingColumnNumber() ?? 0,
          site.getFunctionName() ?? "",
        );
        return [at.file, at.function];
      }),
    ).toEqual([
      [join(root, "src", "names.ts"), "placeOrder"],
      [join(root, "src", "names.ts"), "checkout"],
      [join(root, "src", "names.ts"), "shipOrder"],
    ]);
  });
});
