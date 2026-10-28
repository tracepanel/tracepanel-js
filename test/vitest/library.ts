// The app the fixture's tests test: books and their authors in Postgres, and a server that lists them.
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";

type Pool = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
};
const pg = createRequire(import.meta.url)("pg") as {
  Pool: new (options: { connectionString: string | undefined }) => Pool;
};

export const pool = new pg.Pool({ connectionString: process.env.TRACEPANEL_TEST_POSTGRES });

export async function seed(): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS vitest_books, vitest_authors");
  await pool.query("CREATE TABLE vitest_authors (id serial PRIMARY KEY, name text NOT NULL)");
  await pool.query("CREATE TABLE vitest_books (id serial PRIMARY KEY, title text NOT NULL, author_id int NOT NULL)");
  for (const [author, title] of [
    ["Herbert", "Dune"],
    ["Le Guin", "Earthsea"],
    ["Banks", "Excession"],
    ["Lem", "Solaris"],
  ]) {
    const { rows } = await pool.query("INSERT INTO vitest_authors (name) VALUES ($1) RETURNING id", [author]);
    await pool.query("INSERT INTO vitest_books (title, author_id) VALUES ($1, $2)", [title, rows[0]?.id]);
  }
}

/** Each book with its author's name: a query for the books, then one per book. */
export async function booksOneByOne(): Promise<string[]> {
  const { rows } = await pool.query("SELECT id, title, author_id FROM vitest_books ORDER BY id");
  const listed: string[] = [];
  for (const book of rows) {
    const author = await pool.query("SELECT name FROM vitest_authors WHERE id = $1", [book.author_id]);
    listed.push(`${book.title} by ${author.rows[0]?.name}`);
  }
  return listed;
}

/** Each book with its author's name, in one query. */
export async function booksJoined(): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT b.title, a.name FROM vitest_books b JOIN vitest_authors a ON a.id = b.author_id ORDER BY b.id",
  );
  return rows.map((row) => `${row.title} by ${row.name}`);
}

/** The same count, asked once for each of two widgets that show it. */
export async function countTwice(): Promise<number[]> {
  const counts: number[] = [];
  for (const _widget of ["header", "sidebar"]) {
    const { rows } = await pool.query("SELECT count(*) FROM vitest_books WHERE title = $1", ["Dune"]);
    counts.push(Number(rows[0]?.count));
  }
  return counts;
}

/** GET /books: the books one by one, as JSON. */
export function server(): Promise<{ url: string; close(): Promise<void> }> {
  const listening: Server = createServer(async (_req, res) => {
    const books = await booksOneByOne();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(books));
  });
  return new Promise((done) => {
    listening.listen(0, "127.0.0.1", () => {
      const address = listening.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((closed) => listening.close(() => closed())),
      });
    });
  });
}
