// OpenTelemetry for the app, with Tracepanel's span processor: what `tracepanel/register` sets up before the app,
// and what a framework that starts its own server (Next.js) sets up from its instrumentation hook.

import { createRequire, register } from "node:module";
import { join } from "node:path";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { captureConsole, NestLogs } from "./logs.js";
import { type Runtime, runtime } from "./runtime.js";

export interface Options {
  /**
   * Node's HTTP server spans, the request's root. Off where the framework makes its own root span (Next.js), which
   * would otherwise sit under another.
   */
  httpServer?: boolean;
}

const STARTED = Symbol.for("tracepanel.started");

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

/** Sets up tracing once per process; undefined when Tracepanel is off (production). */
export function start(options: Options = {}): Runtime | undefined {
  const tracepanel = runtime();
  const holder = globalThis as { [STARTED]?: boolean };
  if (!tracepanel || holder[STARTED]) return tracepanel;
  holder[STARTED] = true;
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  new NodeTracerProvider({ spanProcessors: [tracepanel.processor] }).register();
  const instrumentations: Instrumentation[] = [
    new ExpressInstrumentation(),
    // A Nest app runs on Express: Nest's spans name the controller and method that handled the request.
    nest(),
    new NestLogs(tracepanel.processor),
    new PgInstrumentation({ enhancedDatabaseReporting: true }),
    new MySQL2Instrumentation(),
  ];
  if (options.httpServer !== false) instrumentations.unshift(new HttpInstrumentation());
  registerInstrumentations({ instrumentations });
  captureConsole(tracepanel.processor);
  return tracepanel;
}
