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

  it("names a schema-qualified table by the table, its schema and quotes left out", () => {
    expect(
      [
        'SELECT "public"."category"."id", "public"."category"."name" FROM "public"."category" WHERE 1=1',
        'SELECT COUNT(*) AS "_count$_all" FROM (SELECT "public"."order"."id" FROM "public"."order" OFFSET $1) AS "sub"',
        'SELECT "t1"."id" FROM "public"."order_item" AS "t1" LEFT JOIN "public"."product" AS "t2" ON "t2"."id" = 1',
        'INSERT INTO "public"."order" ("number") VALUES ($1) RETURNING "public"."order"."id"',
        'UPDATE "public"."product" SET "stock" = $1 WHERE "public"."product"."id" = $2',
        'DELETE FROM "public"."cart_item" WHERE "public"."cart_item"."customer_id" = $1',
        "SELECT `book`.`id` FROM `shop`.`book` JOIN `shop`.`author` ON `author`.`id` = `book`.`author_id`",
        "UPDATE `shop` . `book` SET `price` = ?",
        "SELECT [id] FROM [dbo].[orders]",
        "SELECT * FROM shop.books",
        'SELECT id FROM "Order Items"',
      ].map(spanName),
    ).toEqual([
      "SELECT category",
      "SELECT COUNT order",
      "SELECT order_item",
      "INSERT order",
      "UPDATE product",
      "DELETE cart_item",
      "SELECT book",
      "UPDATE book",
      "SELECT orders",
      "SELECT books",
      "SELECT Order Items",
    ]);
  });

  it("closes a line comment on one line and names and groups a query without its comments, as the agent does", () => {
    const sql =
      "/*controller='orders',traceparent='00-4bf9-01'*/ SELECT id\n-- the page's rows\nFROM orders " +
      "WHERE note = '-- not /* a */ comment' AND id IN ($1, $2)";

    expect([statement(sql), fingerprint(sql), spanName(sql)]).toEqual([
      "/*controller='orders',traceparent='00-4bf9-01'*/ SELECT id /* the page's rows */ FROM orders " +
        "WHERE note = '-- not /* a */ comment' AND id IN ($1, $2)",
      "SELECT id FROM orders WHERE note = '-- not /* a */ comment' AND id IN (...)",
      "SELECT orders",
    ]);
  });

  it("leaves out a leading traceparent comment", () => {
    const sql = "/*traceparent='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'*/ SELECT * FROM orders";

    expect([statement(sql), fingerprint(sql), spanName(sql)]).toEqual([sql, "SELECT * FROM orders", "SELECT orders"]);
  });

  it("closes a line comment mid-statement, a */ in it kept from ending it", () => {
    const sql = "SELECT count(*)\n  -- the */ count\n  FROM books --\nWHERE id = $1";

    expect([statement(sql), fingerprint(sql), spanName(sql)]).toEqual([
      "SELECT count(*) /* the * / count */ FROM books /* */ WHERE id = $1",
      "SELECT count(*) FROM books WHERE id = $1",
      "SELECT COUNT books",
    ]);
  });

  it("leaves -- and /* in a string or a quoted name as they are", () => {
    const sql = "SELECT \"a--b\", `c/*d` FROM notes WHERE body = 'it''s -- not /* a comment' AND x = \"--\"";

    expect([statement(sql), fingerprint(sql), spanName(sql)]).toEqual([sql, sql, "SELECT notes"]);
  });
});
