// Which statements EXPLAIN may run: the cases mirror the agent's schema/explainable.json.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { checkExplain, explainRefusal } from "../src/explainable.js";

interface Case {
  sql: string;
  explain: string | null;
  analyze: string | null;
}

const cases = JSON.parse(readFileSync(new URL("fixtures/explainable.json", import.meta.url), "utf8")) as Case[];

test.each(cases)("$sql", ({ sql, explain, analyze }) => {
  const refusals = { explain: explainRefusal(sql, false), analyze: explainRefusal(sql, true) };

  expect(refusals).toEqual({ explain, analyze });
});

test("the agent's EXPLAIN of each database is checked with ANALYZE as its prefix says", () => {
  const lock = "SELECT * FROM t FOR UPDATE";

  expect(() => checkExplain(`EXPLAIN ${lock}`, "postgresql")).not.toThrow();
  expect(() => checkExplain(`EXPLAIN QUERY PLAN ${lock}`, "sqlite")).not.toThrow();
  expect(() => checkExplain("EXPLAIN WITH a AS (SELECT 1) SELECT * FROM a", "mysql")).not.toThrow();

  expect(() => checkExplain(`EXPLAIN (ANALYZE, BUFFERS) ${lock}`, "postgresql")).toThrow(
    "This query locks rows (FOR UPDATE): it can be explained, not analyzed.",
  );
  expect(() => checkExplain(`EXPLAIN ANALYZE ${lock}`, "mysql")).toThrow(
    "This query locks rows (FOR UPDATE): it can be explained, not analyzed.",
  );
});

test("anything but the agent's EXPLAIN of an explainable statement is refused", () => {
  const refused = [
    ["EXPLAIN WITH gone AS (DELETE FROM t RETURNING id) SELECT * FROM gone", "postgresql"],
    ["SELECT 1", "postgresql"],
    ["EXPLAIN (ANALYZE, COSTS OFF) DELETE FROM t", "postgresql"],
    ["EXPLAIN SELECT 1", "sqlite"],
    ["DELETE FROM t", "sqlite"],
    ["EXPLAIN SELECT 1", "mssql"],
  ].map(([sql, vendor]) => {
    try {
      checkExplain(sql as string, vendor as string);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  });

  expect(refused).toEqual([
    "This query changes data (DELETE inside WITH): it isn't explained.",
    "Only SELECT statements can be explained.",
    "Only SELECT statements can be explained.",
    "Only SELECT statements can be explained.",
    "Only SELECT statements can be explained.",
    "Only SELECT statements can be explained.",
  ]);
});
