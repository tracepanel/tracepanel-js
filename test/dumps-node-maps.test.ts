// A dump in a bundle Node maps itself (--enable-source-maps): Node's stack names the source, which may not be on
// disk. The call's place in the code that ran (V8's CallSites) is mapped here again, where the map's sourcesContent is
// at hand, and the global prepareStackTrace is left as it was.
// biome-ignore-all lint/suspicious/noConsole: the terminal's console method, swapped and put back.

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { captureConsole } from "../src/console.js";
import type { Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const SOURCE = new URL("./app/debug.ts", import.meta.url);
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
let root = "";
let bundle: { inspectOrder(): void; stack(): string };
const log = console.log;
const printed: unknown[][] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tracepanel-node-maps-")));
  mkdirSync(join(root, "gone"));
  copyFileSync(SOURCE, join(root, "gone", "debug.ts"));
  writeFileSync(
    join(root, "gone", "entry.ts"),
    'export { inspectOrder } from "./debug";\nexport function stack() {\n  return new Error().stack ?? "";\n}\n',
  );
  const out = join(root, "dist", "debug.cjs");
  buildSync({
    entryPoints: [join(root, "gone", "entry.ts")],
    outfile: out,
    bundle: true,
    format: "cjs",
    platform: "node",
    minify: true,
    sourcemap: "linked",
    logLevel: "silent",
  });
  // The source is gone: only the map's sourcesContent has it.
  rmSync(join(root, "gone"), { recursive: true });
  process.setSourceMapsEnabled(true);
  // Node's own require(), outside Vitest's modules: Node loads the bundle with its map.
  bundle = createRequire(import.meta.url)(out);
  console.log = (...args: unknown[]) => printed.push(args);
});

afterAll(() => {
  console.log = log;
  process.setSourceMapsEnabled(false);
  manager.disable();
  rmSync(root, { recursive: true, force: true });
});

it("reads the arguments through the bundle's map, from its sourcesContent, as Node maps the stack", async () => {
  const config: Config = { ...loadConfig({}), enabled: true, root, service: "shop" };
  const sent: Trace[] = [];
  const processor = new TracepanelProcessor(config, { submit: (done) => sent.push(done) });
  const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("test");
  captureConsole(processor, config);
  // Node's own stack, as an app has it (Vitest puts its own prepareStackTrace there).
  const vitest = Error.prepareStackTrace;
  (Error as { prepareStackTrace?: unknown }).prepareStackTrace = undefined;
  let prepare: unknown = null;
  let nodeStack = "";

  const span = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/orders" },
  });
  try {
    nodeStack = bundle.stack();
    context.with(trace.setSpan(context.active(), span), () => bundle.inspectOrder());
    prepare = Error.prepareStackTrace;
  } finally {
    Error.prepareStackTrace = vitest;
  }
  span.end();
  await new Promise((done) => setTimeout(done, 60));

  expect(sent.at(-1)?.logs.map((entry) => entry.attrs)).toEqual([
    {
      "log.kind": "dump",
      "dump.lang": "javascript",
      "dump.args": [
        { expr: "order", repr: "{\n  id: 7,\n  items: [\n    'book',\n    'pen'\n  ]\n}", type: "Object", len: null },
        { expr: "order.items.length", repr: "2", type: "number", len: null },
      ],
      // The function as the minified bundle names it.
      "code.origin": expect.stringMatching(/^gone\/debug\.ts:8 in \w+$/),
    },
  ]);

  // Node maps the stack to the source, which isn't there; the global prepareStackTrace is as it was.
  expect(nodeStack).toContain(`${join(root, "gone", "entry.ts")}:3:`);
  expect(prepare).toBeUndefined();

  expect(printed).toEqual([[{ id: 7, items: ["book", "pen"] }, 2]]);
});
