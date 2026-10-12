import { describe, expect, it } from "vitest";
import { fingerprint, spanName, statement } from "../src/sql.js";

describe("sql", () => {
  it("folds whitespace into one line", () => {
    expect(statement("SELECT *\n  FROM books\n WHERE id = $1")).toBe("SELECT * FROM books WHERE id = $1");
  });

  it("folds IN lists, as every SDK does", () => {
    expect(fingerprint("SELECT * FROM books WHERE id IN ($1, $2, $3)")).toBe("SELECT * FROM books WHERE id IN (...)");
  });

  it("names a span after its verb and table", () => {
    expect(spanName("SELECT name FROM authors WHERE id = $1")).toBe("SELECT authors");
    expect(spanName("select count(*) from books")).toBe("SELECT COUNT books");
    expect(spanName('INSERT INTO "books" (title) VALUES ($1)')).toBe("INSERT books");
    expect(spanName("BEGIN")).toBe("BEGIN");
  });
});
