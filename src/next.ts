// Next.js starts its own server, before any `--import` could reach it, and makes the request's root span itself.
// Tracepanel goes in from the app's instrumentation hook:
//
//   // instrumentation.ts
//   export async function register() {
//     if (process.env.NEXT_RUNTIME === "nodejs") (await import("@tracepanel/js/next")).register();
//   }
//
// In development the app's server then answers /__tracepanel__/ itself, before Next.js sees the request: the console
// of the project's agent on the app's own origin, as @tracepanel/js/vite serves it. The widget loads from there and
// the page's recording sends its traces there (`<Tracepanel />` in the root layout). Only this machine reaches it, and
// none of it is a trace of the app's.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { context } from "@opentelemetry/api";
import type { BrowserOptions } from "./browser.js";
import { headersOnResponses } from "./headers.js";
import { ASKED, asks, REASON } from "./profile.js";
import { answeredHere, browserModule, forward, PREFIX, recordingScript } from "./proxy.js";
import type { Runtime } from "./runtime.js";
import { start } from "./setup.js";

const SERVING = Symbol.for("tracepanel.next.console");
// Scripts Next.js serves for itself in development, by a part of their path: its client and hot reload, bundled by
// Turbopack (/_next/static/chunks/<hash>_next_dist_client_<hash>.js) or webpack. Their console isn't the page's.
const NEXT_SOURCES = ["_next_dist_client_", "_browser_dev_hmr-client_", "/next/dist/client/"];

/** OpenTelemetry for the app, without Node's HTTP server spans: Next's root span is the request. */
export function register(): void {
  const tracepanel = start({ httpServer: false });
  if (!tracepanel) return;
  headersOnResponses(tracepanel, "Next.js");
  serveConsole(tracepanel);
}

/** /__tracepanel__/<path> (the URL with the prefix taken off): answered here, or by the project's agent. */
function answer(tracepanel: Runtime, req: IncomingMessage, res: ServerResponse): void {
  req.url = (req.url ?? PREFIX).slice(PREFIX.length - 1);
  if (answeredHere(req, res)) return;
  // No agent yet (the app starts it on its first request): the page's widget starts it here instead.
  const address = tracepanel.console.get(true) || (tracepanel.starter.ensure() ? tracepanel.console.get(true) : "");
  if (!address) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end(`No Tracepanel console: its agent didn't start (see ${tracepanel.config.storeDir}/agent.log).`);
    return;
  }
  // The agent at that address went away (idle, a new build): a new one, and its console.
  const restart = () => (tracepanel.starter.ensure(true) ? tracepanel.console.get(true) || undefined : undefined);
  forward(new URL(address), req, res, restart);
}

/**
 * The app's HTTP servers (Next's, made before this runs) hand a request under /__tracepanel__/ to the console instead
 * of Next.js. The badge's widget loads from there then, and the root layout's `<Tracepanel />` records the page.
 */
export function serveConsole(tracepanel: Runtime): void {
  tracepanel.onOrigin = {
    prefix: PREFIX,
    recording: (options: BrowserOptions) =>
      recordingScript(browserModule(), { api: PREFIX, ignoreSources: NEXT_SOURCES, ...options }),
  };
  for (const prototype of [http.Server.prototype, https.Server.prototype]) {
    const server = prototype as http.Server & { [SERVING]?: boolean };
    if (server[SERVING]) continue;
    server[SERVING] = true;
    const emit = server.emit;
    server.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]) {
      const req = args[0] as IncomingMessage | undefined;
      if (event === "request" && req?.url?.startsWith(PREFIX)) {
        answer(tracepanel, req, args[1] as ServerResponse);
        return true;
      }
      // A request that asks to be profiled: Next.js starts its root span in this context, which says what it asked.
      const ask = event === "request" && req ? asks(req.headers) : undefined;
      if (ask) {
        const asking = context.active().setValue(ASKED, ask.asked).setValue(REASON, ask.reason);
        return context.with(asking, () => emit.call(this, event, ...args));
      }
      return emit.call(this, event, ...args);
    } as typeof emit;
  }
}
