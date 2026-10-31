// biome-ignore-all lint/suspicious/noConsole: the app's debug output is what the tests read.
// The app's debug output: console.dir(), console.table(), console.log() of objects. Each call's line is the dump's
// code.origin, its arguments' text the dump's.

/** An order and how many items it has, logged to look into them. */
export function inspectOrder(): void {
  const order = { id: 7, items: ["book", "pen"] };
  console.log(order, order.items.length); // log
}

/** The same order through console.dir() and console.table(). */
export function dirAndTable(): void {
  const order = { id: 7, items: ["book", "pen"] };
  console.dir(order, { depth: 0 }); // dir
  console.table([{ sku: "book", qty: 1 }]); // table
}

/** A log line of primitives only: no inspection, a log line as before. */
export function plainLine(): void {
  console.log("order", 7, "placed");
}

/** A secret next to an object, a literal before them. */
export function withSecret(): void {
  const apiToken = "s3cr3t";
  const user = { name: "ann" };
  console.log("user:", user, apiToken); // secret
}

/** A string past the limit, in a Map, the call over several lines with a nested call. */
export function longValue(): void {
  const big = new Map([["text", "x".repeat(20_000)]]);
  // biome-ignore format: the call's comment stays on its line.
  console.info( // info
    big, // several lines
    [1, 2, 3].map((n) => ({ n, label: `n=${n}, (${"a,b"})` })),
  );
}
