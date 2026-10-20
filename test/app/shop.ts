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

/** Work on the CPU for a while: what a profile finds. One function for each test, each run once: V8 may leave a
 * function that it optimized earlier out of a later profile's stacks. */
function crunch(ms: number): number {
  const until = performance.now() + ms;
  let total = 0;
  while (performance.now() < until) total += Math.sqrt(total + 1);
  return total;
}

export function crunchPrices(ms: number): number {
  return crunch(ms);
}

export function crunchTaxes(ms: number): number {
  return crunch(ms);
}

export function crunchRates(ms: number): number {
  return crunch(ms);
}

export function crunchOrders(ms: number): number {
  return crunch(ms);
}

/** Another request's work. */
export function crunchStock(ms: number): number {
  return crunch(ms);
}

/** Charges a customer and fails: its locals are what the error shows. */
export function chargeCard(customer: { id: number; name: string }, password: string): void {
  const attempts = 3;
  const note = "x".repeat(300);
  if (attempts > 2) throw new Error(`card declined for ${customer.name} (${password.length}, ${note.length})`); // declined
}

/** Places an order, which charges the card. */
export function placeOrder(items: string[]): void {
  const total = items.length * 10;
  chargeCard({ id: 7, name: "Ann" }, `s3cret-${total}`); // ordered
}

/** Charges the card after a wait. */
export async function chargeLater(customer: { id: number; name: string }, password: string): Promise<void> {
  await Promise.resolve();
  chargeCard(customer, password); // later
}

/** Places an order whose charge fails after a wait: the order is waiting on an `await` as the error is thrown. */
export async function placeOrderLater(items: string[]): Promise<void> {
  const total = items.length * 10;
  await chargeLater({ id: 7, name: "Ann" }, `s3cret-${total}`); // awaited
}
