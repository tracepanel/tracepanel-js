// `node --import tracepanel/register app.js`: OpenTelemetry for the app, with Tracepanel's span processor. Loaded
// before the app, it can instrument both CommonJS and ES modules (the ESM loader hook goes in first).

import { createRequire, register } from "node:module";
import { join } from "node:path";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { captureConsole, NestLogs } from "./logs.js";
import { runtime } from "./runtime.js";

const tracepanel = runtime();

/**
 * Nest 12 is ESM: the loader hook patches its files as they load. The instrumentation also requires them, from its
 * own place and the main module's; with the SDK linked from elsewhere, or no CommonJS main module, that misses the
 * project's @nestjs/core and throws as Nest loads. Here it looks from the project's directory too, and a miss is fine.
 */
function nest(): NestInstrumentation {
  const instrumentation = new NestInstrumentation();
  const target = instrumentation as unknown as { loadPatchedFiles(moduleVersion?: string): void };
  const loadPatchedFiles = target.loadPatchedFiles.bind(instrumentation);
  target.loadPatchedFiles = (moduleVersion) => {
    try {
      loadPatchedFiles(moduleVersion);
    } catch {
      try {
        const fromProject = createRequire(join(process.cwd(), "package.json"));
        for (const file of ["@nestjs/core/nest-factory.js", "@nestjs/core/router/router-execution-context.js"]) {
          fromProject(file);
        }
      } catch {
        // The ESM loader hook has patched them already.
      }
    }
  };
  return instrumentation;
}

if (tracepanel) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  new NodeTracerProvider({ spanProcessors: [tracepanel.processor] }).register();
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // The widget's assets and the console come from the agent, not through the app; nothing to skip here yet.
      }),
      new ExpressInstrumentation(),
      // A Nest app runs on Express: Nest's spans name the controller and method that handled the request.
      nest(),
      new NestLogs(tracepanel.processor),
      new PgInstrumentation({ enhancedDatabaseReporting: true }),
      new MySQL2Instrumentation(),
    ],
  });
  captureConsole(tracepanel.processor);
}
