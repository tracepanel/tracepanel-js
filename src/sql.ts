// A statement's span name, its one-line form, and its fingerprint, which the agent groups queries (and finds N+1
// queries) by: the same rules in every Tracepanel SDK.

const WHITESPACE = /\s+/g;
const IN_LIST = /\bIN \((?:%s|\?|\$\d+)(?:, ?(?:%s|\?|\$\d+))*\)/gi;
// One part of a table's name, bare or quoted: "standard SQL", `MySQL`, [SQL Server].
const PART = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`;
// The table a statement reads or writes, with its schema (Prisma's "public"."category", MySQL's `shop`.`book`).
const TABLE = new RegExp(String.raw`\b(?:FROM|INTO|UPDATE|JOIN)\s+(${PART}(?:\s*\.\s*${PART})*)`, "i");
const PARTS = new RegExp(PART, "g");
const COUNT = /^\s*SELECT\s+COUNT\(/i;

export function statement(sql: string): string {
  return sql.replace(WHITESPACE, " ").trim();
}

export function fingerprint(sql: string): string {
  return statement(sql).replace(IN_LIST, "IN (...)");
}

/** `SELECT category`: the verb and the table, its schema and quotes left out. */
export function spanName(sql: string): string {
  const verb = COUNT.test(sql) ? "SELECT COUNT" : (sql.trim().split(/\s+/)[0] ?? "SQL").toUpperCase() || "SQL";
  const name = TABLE.exec(sql)?.[1];
  const table = name
    ?.match(PARTS)
    ?.at(-1)
    ?.replace(/^["`[]|["`\]]$/g, "");
  return table ? `${verb} ${table}` : verb;
}
