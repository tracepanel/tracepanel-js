// The Nitro plugin @tracepanel/js/nuxt adds in development. Nitro bundles it into the server: it reads the process's
// Tracepanel from globalThis and brings no OpenTelemetry of its own.

import { captureConsole } from "./console.js";
import { headersOnResponses } from "./headers.js";
import type { Runtime } from "./runtime.js";
import { h3Sessions } from "./session.js";

const KEY = Symbol.for("tracepanel.runtime");

interface Event {
  method?: string;
  path?: string;
  context: { matchedRoute?: { path?: string }; sessions?: unknown };
}

interface NitroApp {
  hooks: {
    hook(name: "request" | "beforeResponse", handler: (event: Event) => void): void;
    hook(name: "render:html", handler: (html: { head: string[] }, context: { event: Event }) => void): void;
    hook(name: "error", handler: (error: unknown, context: { event?: Event }) => void): void;
  };
}

export default function tracepanelPlugin(nitroApp: NitroApp): void {
  const tracepanel = (globalThis as { [KEY]?: Runtime })[KEY];
  if (!tracepanel) return;
  headersOnResponses(tracepanel, "Nuxt");
  // Nuxt's dev server replaced console with its own logger after --import wrapped it.
  captureConsole(tracepanel.processor, tracepanel.config);
  // h3 answers a thrown error with a 500 and records it nowhere: the request's trace gets it here.
  // createError({ statusCode: 404 }) and the like are answers, not errors.
  nitroApp.hooks.hook("error", (error) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) tracepanel.processor.addError(error);
  });
  nitroApp.hooks.hook("request", () => tracepanel.processor.setFramework("Nuxt"));
  // The route is matched by then. The renderer's catch-all (/**) serves every page: its path names a page better.
  nitroApp.hooks.hook("beforeResponse", (event) => {
    const route = event.context.matchedRoute?.path;
    if (route && !route.includes("**")) tracepanel.processor.setRoute(route);
    // The sessions useSession() read (nuxt-auth-utils' among them), as the handler left them.
    const session = tracepanel.config.captureRequest ? h3Sessions(event.context.sessions) : {};
    if (Object.keys(session).length > 0) {
      tracepanel.processor.setTraceAttrs(session, { method: event.method ?? "GET", url: event.path ?? "/" });
    }
  });
  nitroApp.hooks.hook("render:html", (html, { event }) => {
    const marks = tracepanel.badge({
      method: event.method ?? "GET",
      status: 200,
      startedMs: performance.now(),
      page: true,
      framework: tracepanel.processor.framework() ?? "Nuxt",
    });
    if (marks?.script) html.head.unshift(marks.script);
  });
}
