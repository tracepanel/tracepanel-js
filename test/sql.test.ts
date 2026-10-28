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
});
