// The app in the tests that need one: its lines are the code.origin of what it does. The test files around it stand
// for the libraries (Next.js, undici, pg), whose code is not the app's.

import { SpanKind, type Tracer } from "@opentelemetry/api";

type Fetch = (url: string) => Promise<Response>;

/** Two carriers' rates at once, one fetch each. */
export async function shippingRates(fetch: Fetch): Promise<void> {
  await Promise.all([
    fetch("http://127.0.0.1:8062/ups"), // ups
    fetch("http://127.0.0.1:8062/dhl"), // dhl
  ]);
}

/** A query, then a call to another service. */
export async function checkout(tracer: Tracer, fetch: Fetch): Promise<void> {
  tracer
    .startSpan("pg.query:SELECT shop", {
      kind: SpanKind.CLIENT,
      attributes: { "db.system": "postgresql", "db.statement": "SELECT 1" },
    })
    .end();
  await fetch("http://127.0.0.1:8062/charge"); // charge
}

/** Runs a library call, which finds the app's line however deep its own stack goes. */
export function underLibrary<T>(call: () => T): T {
  return call(); // library
}
