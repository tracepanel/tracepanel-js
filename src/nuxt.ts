// `modules: ["@tracepanel/js/nuxt"]` in nuxt.config: a Nitro plugin that names each request by its route, puts the badge
// on server-rendered pages and the trace's id on every response. OpenTelemetry itself goes in before Nitro, with
// `NODE_OPTIONS=--import=@tracepanel/js/register nuxt dev`, so it can hook the database driver as Nitro loads it.

import { fileURLToPath } from "node:url";

interface Nuxt {
  options: { dev: boolean; nitro: { plugins?: string[] } };
}

export default function tracepanelModule(_options: unknown, nuxt: Nuxt): void {
  if (!nuxt.options.dev) return;
  nuxt.options.nitro.plugins = [
    ...(nuxt.options.nitro.plugins ?? []),
    fileURLToPath(new URL("./nuxt-plugin.js", import.meta.url)),
  ];
}

Object.assign(tracepanelModule, {
  getMeta: () => Promise.resolve({ name: "tracepanel", configKey: "tracepanel" }),
});
