// Next.js starts its own server, before any `--import` could reach it, and makes the request's root span itself.
// Tracepanel goes in from the app's instrumentation hook:
//
//   // instrumentation.ts
//   export async function register() {
//     if (process.env.NEXT_RUNTIME === "nodejs") (await import("@tracepanel/js/next")).register();
//   }

import { headersOnResponses } from "./headers.js";
import { start } from "./setup.js";

/** OpenTelemetry for the app, without Node's HTTP server spans: Next's root span is the request. */
export function register(): void {
  const tracepanel = start({ httpServer: false });
  if (tracepanel) headersOnResponses(tracepanel, "Next.js");
}
