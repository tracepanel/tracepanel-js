// `node --import tracepanel/register app.js`: OpenTelemetry for the app, with Tracepanel's span processor. Loaded
// before the app, it can instrument both CommonJS and ES modules (the ESM loader hook goes in first).

import { register } from "node:module";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { captureConsole } from "./logs.js";
import { runtime } from "./runtime.js";

const tracepanel = runtime();

if (tracepanel) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  new NodeTracerProvider({ spanProcessors: [tracepanel.processor] }).register();
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // The widget's assets and the console come from the agent, not through the app; nothing to skip here yet.
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: true }),
      new MySQL2Instrumentation(),
    ],
  });
  captureConsole(tracepanel.processor);
}
