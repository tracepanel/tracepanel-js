// The project test/vitest-live.test.ts runs Vitest on: its tests run under the plugin, from this repository's source.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { tracepanel } from "../../src/vitest.js";

export default defineConfig({
  plugins: [tracepanel()],
  test: { root: fileURLToPath(new URL(".", import.meta.url)), include: ["*.fixture.ts"] },
});
