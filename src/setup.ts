// OpenTelemetry for the app, with Tracepanel's span processor: what `@tracepanel/js/register` sets up before the app,
// and what a framework that starts its own server (Next.js) sets up from its instrumentation hook.

import nodeModule, { createRequire, register } from "node:module";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { MongoDBInstrumentation } from "@opentelemetry/instrumentation-mongodb";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { register as registerSyncHooks, supportsSyncHooks } from "import-in-the-middle/register-hooks.mjs";
import { awsInstrumentation } from "./aws.js";
import { BullMQInstrumentation } from "./bullmq.js";
import { captureConsole } from "./console.js";
import { DatabasesInstrumentation } from "./explain.js";
import { traceFetch } from "./fetch.js";
import { LlmInstrumentation, traceLlmFetch } from "./llm.js";
import { PinoLogs, WinstonLogs } from "./loggers.js";
import { NestLogs } from "./logs.js";
import { traceBunCalls } from "./outgoing.js";
import { ATTRIBUTE as PROFILE, requested } from "./profile.js";
import { type Runtime, runtime } from "./runtime.js";
import { SqliteInstrumentation } from "./sqlite.js";
import { TransactionsInstrumentation } from "./transactions.js";

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

/**
 * `nuxt dev`'s main thread: it only builds and proxies each request to Nitro's worker thread, which serves it (and
 * gets the same --import). Tracing it would make a second, empty trace of every request.
 */
function nuxtDevProxy(): boolean {
  const script = process.argv[1] ?? "";
  return isMainThread && /[\\/]nuxi?(\.m?js)?$|[\\/]nuxt[\\/]bin[\\/]/.test(script) && process.argv.includes("dev");
}

/** Sets up tracing once per process; undefined when Tracepanel is off (production). */
export function start(options: Options = {}): Runtime | undefined {
  const tracepanel = runtime();
  const holder = globalThis as { [STARTED]?: boolean };
  if (!tracepanel || holder[STARTED] || nuxtDevProxy()) return tracepanel;
  holder[STARTED] = true;
  // The ESM loader hook, in the app's thread where Node can (module.register() is deprecated from Node 26). Bun 1.4
  // says it is Node 26 but has no registerHooks(): supportsSyncHooks() goes by the version only.
  if (supportsSyncHooks() && typeof nodeModule.registerHooks === "function") registerSyncHooks();
  else register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  new NodeTracerProvider({ spanProcessors: [tracepanel.processor] }).register();
  const bun = process.versions.bun !== undefined;
  const instrumentations: Instrumentation[] = [
    new ExpressInstrumentation(),
    // A Nest app runs on Express: Nest's spans name the controller and method that handled the request.
    nest(),
    new NestLogs(tracepanel.processor),
    new PinoLogs(tracepanel.processor),
    new WinstonLogs(tracepanel.processor),
    new PgInstrumentation({ enhancedDatabaseReporting: true }),
    new MySQL2Instrumentation(),
    new IORedisInstrumentation(),
    new RedisInstrumentation(),
    // The command with its values: Tracepanel keeps their shape and a hash, which tells duplicates from an N+1.
    new MongoDBInstrumentation({ enhancedDatabaseReporting: true }),
    new PrismaInstrumentation(),
    // BEGIN … COMMIT on a connection as a transaction span: after pg's and mysql2's, so its statements are inside.
    new TransactionsInstrumentation(),
    // SQLite: better-sqlite3, node:sqlite and libsql, their transactions too.
    new SqliteInstrumentation(),
    // Its jobs' task events too, for the console's Live list.
    new BullMQInstrumentation(tracepanel.processor),
    // The databases the app queries, for the console's EXPLAIN.
    new DatabasesInstrumentation(),
    // The AWS SDK's clients: each command a call to AWS (S3 a storage call, DynamoDB a datastore's).
    awsInstrumentation(),
    // OpenAI's and Anthropic's clients: each call to a model an LLM call.
    new LlmInstrumentation(),
    // fetch(): Node's own, through undici (Bun's: traceBunCalls() below).
    ...(bun ? [] : [new UndiciInstrumentation()]),
    // Outgoing calls through node:http (axios, got) always; the server's requests unless the framework traces them.
    new HttpInstrumentation({
      // Bun's node:http calls are traceBunCalls()'s.
      ignoreOutgoingRequestHook: () => bun,
      // A CORS preflight (the browser asking before a call with a traceparent) is the browser's, not the app's work.
      ignoreIncomingRequestHook: (request) =>
        options.httpServer === false ||
        (request.method === "OPTIONS" && request.headers["access-control-request-method"] !== undefined),
      // What a request asks to be profiled for says so on its span, as it starts.
      startIncomingSpanHook: (request) => {
        const asked = tracepanel.config.profileEnabled && "headers" in request ? requested(request.headers) : undefined;
        return asked ? { [PROFILE]: asked } : {};
      },
    }),
  ];
  registerInstrumentations({ instrumentations });
  // fetch() takes the app's line as it is called: undici starts its span later, away from the app's code. Bun's
  // fetch and node:http have no instrumentation that sees them: their calls are traced here.
  if (bun) traceBunCalls();
  else traceFetch(tracepanel.config.root);
  // Calls to a model's API through fetch() (the AI SDK's providers): around the call's own span.
  traceLlmFetch();
  captureConsole(tracepanel.processor);
  return tracepanel;
}
