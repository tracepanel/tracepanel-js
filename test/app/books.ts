// The handlers' own code in the framework tests: the line of each query is its code.origin, and an error thrown here
// has its frames' local variables.

import { SpanKind, trace } from "@opentelemetry/api";

/** A book by its id: one statement, as pg's instrumentation records it. */
export function findBook(id: string): { id: string } {
  const attributes = { "db.system": "postgresql", "db.statement": "SELECT * FROM books WHERE id = $1" };
  trace.getTracer("pg").startSpan("pg.query", { kind: SpanKind.CLIENT, attributes }).end(); // find book
  return { id };
}

/** A book's reservation, which fails: none is left. */
export function reserve(id: string, customer: { name: string; email: string }): never {
  const stock = { id, left: 0 };
  throw new Error(`no copy of book ${stock.id} left for ${customer.name}`); // out of stock
}
