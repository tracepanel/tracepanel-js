// The app's SQLite code in the tests: its lines are the code.origin of each statement. Any driver with
// better-sqlite3's API: better-sqlite3, node:sqlite, libsql.

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): Iterable<unknown>;
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
}

/** Each product's price, one query each: an N+1. */
export function pricesOneByOne(db: Db, ids: number[]): unknown[] {
  const statement = db.prepare("SELECT price FROM product WHERE id = ?");
  // The line in the callback that runs it: the query's origin.
  return ids.map((id) => statement.get(id)); // prices
}

/** Every product, read at once and row by row. */
export function listProducts(db: Db): number {
  const all = db.prepare("SELECT * FROM product").all(); // all
  let read = 0;
  for (const _ of db.prepare("SELECT id FROM product WHERE price > :min").iterate({ min: 0 })) read += 1; // iterate
  return all.length + read;
}

/** An order, in a transaction the app writes itself. */
export function placeOrder(db: Db, total: number): void {
  db.exec("BEGIN");
  db.prepare("INSERT INTO orders (total) VALUES (?)").run(total); // ordered
  db.exec("COMMIT");
}
