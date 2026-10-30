// A statement's span name, its one-line form, and its fingerprint, which the agent groups queries (and finds N+1
// queries) by: the same rules in every Tracepanel SDK.

const WHITESPACE = /\s+/g;
// A comment (`-- a note` to the line's end, `/* sqlcommenter's tags */`), or a string or quoted name, whose `--` and
// `/*` are its text: matched so a comment is told from a string that looks like one.
const COMMENT = /(--[^\n]*)|(\/\*[\s\S]*?\*\/)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g;
const IN_LIST = /\bIN \((?:%s|\?|\$\d+)(?:, ?(?:%s|\?|\$\d+))*\)/gi;
// One part of a table's name, bare or quoted: "standard SQL", `MySQL`, [SQL Server].
const PART = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`;
// The table a statement reads or writes, with its schema (Prisma's "public"."category", MySQL's `shop`.`book`).
const TABLE = new RegExp(String.raw`\b(?:FROM|INTO|UPDATE|JOIN)\s+(${PART}(?:\s*\.\s*${PART})*)`, "i");
const PARTS = new RegExp(PART, "g");
const COUNT = /^\s*SELECT\s+COUNT\(/i;

/** The statement on one line, a line comment (`-- a note`) closed so the line it ended still reads as SQL. */
export function statement(sql: string): string {
  const closed = sql.includes("--")
    ? sql.replace(COMMENT, (found, line?: string) =>
        line === undefined ? found : `/* ${line.slice(2).trim().replaceAll("*/", "* /")} */`,
      )
    : sql;
  return closed.replace(WHITESPACE, " ").trim();
}

/** The one-line statement without its comments (an ORM's or sqlcommenter's tags, a note): what names and groups it. */
function uncommented(sql: string): string {
  if (!sql.includes("--") && !sql.includes("/*")) {
    return statement(sql);
  }
  return statement(
    sql.replace(COMMENT, (found, line?: string, block?: string) =>
      line === undefined && block === undefined ? found : " ",
    ),
  );
}

export function fingerprint(sql: string): string {
  return uncommented(sql).replace(IN_LIST, "IN (...)");
}

/** `SELECT category`: the verb and the table, its schema and quotes left out, its comments too. */
export function spanName(commented: string): string {
  const sql = uncommented(commented);
  const verb = COUNT.test(sql) ? "SELECT COUNT" : (sql.trim().split(/\s+/)[0] ?? "SQL").toUpperCase() || "SQL";
  const name = TABLE.exec(sql)?.[1];
  const table = name
    ?.match(PARTS)
    ?.at(-1)
    ?.replace(/^["`[]|["`\]]$/g, "");
  return table ? `${verb} ${table}` : verb;
}
