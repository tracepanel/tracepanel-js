// A statement's span name, its one-line form, and its fingerprint, which the agent groups queries (and finds N+1
// queries) by: the same rules in every Tracepanel SDK.

const WHITESPACE = /\s+/g;
const IN_LIST = /\bIN \((?:%s|\?|\$\d+)(?:, ?(?:%s|\?|\$\d+))*\)/gi;
const TABLE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+[`"[]?([\w.]+)/i;
const COUNT = /^\s*SELECT\s+COUNT\(/i;

export function statement(sql: string): string {
  return sql.replace(WHITESPACE, " ").trim();
}

export function fingerprint(sql: string): string {
  return statement(sql).replace(IN_LIST, "IN (...)");
}

export function spanName(sql: string): string {
  const verb = COUNT.test(sql) ? "SELECT COUNT" : (sql.trim().split(/\s+/)[0] ?? "SQL").toUpperCase() || "SQL";
  const table = TABLE.exec(sql)?.[1];
  return table ? `${verb} ${table}` : verb;
}
