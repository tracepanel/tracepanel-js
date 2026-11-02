// Which statements EXPLAIN may run, the rule the agent, its console and every SDK share: a SELECT, or a WITH whose
// CTEs and final statement only read. Its words are read outside quoted strings and names and comments, so a keyword
// in a string changes nothing.
//
// - It starts (after its comments) with SELECT, or with WITH and ends in a SELECT.
// - It is one statement: nothing follows a `;` but comments.
// - No INSERT, UPDATE, DELETE or MERGE anywhere (a data-modifying CTE) and no INTO (`SELECT … INTO` makes a table).
// - ANALYZE runs it, so a SELECT that locks rows (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`) is explained but
//   not analyzed. ANALYZE runs in a transaction that is rolled back (explain.ts).

const NOT_SELECT = "Only SELECT statements can be explained.";
const ONE_STATEMENT = "Only one statement can be explained at a time.";
const CHANGING = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
/** What can follow a WITH's CTEs: the statement they are for. */
const MAIN = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE"]);

/** A word (upper-cased) or any other token (a quoted string or name, a number, a sign), with its depth in parentheses. */
interface Token {
  text: string;
  word: boolean;
  depth: number;
}

const changes = (what: string) => `This query changes data (${what}): it isn't explained.`;

/** Why a statement isn't explained (or with `analyze`, analyzed), or null when it is. */
export function explainRefusal(statement: string, analyze: boolean): string | null {
  const tokens = tokenize(statement);
  const words = tokens.map((token) => (token.word ? token.text : ""));
  let withClause: boolean;
  if (words[0] === "SELECT") withClause = false;
  else if (words[0] === "WITH") withClause = true;
  else return NOT_SELECT;
  const end = tokens.findIndex((token) => token.depth === 0 && !token.word && token.text === ";");
  if (end >= 0 && end + 1 < tokens.length) return ONE_STATEMENT;
  const main = withClause ? tokens.findIndex((token) => token.word && token.depth === 0 && MAIN.has(token.text)) : 0;
  const previous = (at: number) => (at > 0 ? (words[at - 1] ?? "") : "");
  const lock = (at: number) => previous(at) === "FOR" || previous(at) === "KEY";
  for (const [at, word] of words.entries()) {
    if (CHANGING.has(word) && !(word === "UPDATE" && lock(at))) {
      const inside = withClause && (main < 0 || at < main) ? " inside WITH" : "";
      return changes(`${word}${inside}`);
    }
  }
  if (words.includes("INTO")) return changes("SELECT INTO");
  if (main < 0 || words[main] !== "SELECT") return NOT_SELECT;
  if (!analyze) return null;
  for (const [at, word] of words.entries()) {
    let locks: string | null = null;
    if (word === "UPDATE" && lock(at)) locks = "FOR UPDATE";
    else if (word === "SHARE" && lock(at)) locks = "FOR SHARE";
    else if (word === "SHARE" && previous(at) === "IN" && words[at - 2] === "LOCK") locks = "LOCK IN SHARE MODE";
    if (locks) return `This query locks rows (${locks}): it can be explained, not analyzed.`;
  }
  return null;
}

const isLetter = (char: string | undefined) => char !== undefined && /\p{L}/u.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_$]/u.test(char);

/**
 * The statement's tokens, without its comments and spaces: a quoted string or name (`'…'` with `''`, `E'…'` with
 * backslashes too, `"…"`, `` `…` ``, `[…]`, PostgreSQL's `$tag$…$tag$`) is one token whose text is never read. The
 * inside of MySQL's `/*! … *\/`, which MySQL runs, is read as the statement.
 */
function tokenize(statement: string): Token[] {
  const chars = [...statement];
  const tokens: Token[] = [];
  let depth = 0;
  let at = 0;
  while (at < chars.length) {
    const char = chars[at] as string;
    const next = chars[at + 1];
    let text: string;
    let word = false;
    if (/\s/u.test(char)) {
      at += 1;
      continue;
    } else if (char === "-" && next === "-") {
      at = past(chars, at + 2, ["\n"]);
      continue;
    } else if (char === "/" && next === "*") {
      at = chars[at + 2] === "!" ? at + 3 : past(chars, at + 2, ["*", "/"]);
      continue;
    } else if (char === "'") {
      // E'…' (PostgreSQL's escape string): a backslash escapes the next character.
      const last = tokens.at(-1);
      const escapes = at > 0 && /[Ee]/.test(chars[at - 1] as string) && last?.word === true && last.text === "E";
      at = quoted(chars, at, "'", escapes);
      text = "'";
    } else if (char === '"' || char === "`") {
      at = quoted(chars, at, char, false);
      text = char;
    } else if (char === "[" && (isLetter(next) || next === "_")) {
      at = past(chars, at + 1, ["]"]);
      text = "[";
    } else if (char === "$" && dollarTag(chars, at)) {
      const tag = dollarTag(chars, at) as string[];
      at = past(chars, at + tag.length, tag);
      text = "$";
    } else if (isLetter(char) || char === "_") {
      const start = at;
      while (isWordChar(chars[at])) at += 1;
      text = chars.slice(start, at).join("").toUpperCase();
      word = true;
    } else if (/[0-9]/.test(char)) {
      while (chars[at] !== undefined && /[\p{L}\p{N}_.]/u.test(chars[at] as string)) at += 1;
      text = "0";
    } else {
      at += 1;
      text = char;
    }
    if (!word && text === ")") depth = Math.max(0, depth - 1);
    tokens.push({ text, word, depth });
    if (!word && text === "(") depth += 1;
  }
  return tokens;
}

/** Where a quote opened at `at` ends: past its closing `quote` (doubled, it is one inside), or the statement's end. */
function quoted(chars: string[], at: number, quote: string, escapes: boolean): number {
  let i = at + 1;
  while (i < chars.length) {
    const char = chars[i];
    if (escapes && char === "\\") i += 2;
    else if (char === quote && chars[i + 1] === quote) i += 2;
    else if (char === quote) return i + 1;
    else i += 1;
  }
  return chars.length;
}

/** Past the first `end` from `from` on, or the statement's end. */
function past(chars: string[], from: number, end: string[]): number {
  for (let i = from; i < chars.length; i += 1) {
    if (end.every((char, offset) => chars[i + offset] === char)) return i + end.length;
  }
  return chars.length;
}

/** PostgreSQL's dollar quote opening at `at`: `$$` or `$tag$` (not a `$1` parameter). */
function dollarTag(chars: string[], at: number): string[] | null {
  for (let end = at + 1; end < chars.length; end += 1) {
    const char = chars[end] as string;
    if (char === "$") return chars.slice(at, end + 1);
    const first = end === at + 1;
    if (!(isLetter(char) || char === "_" || (!first && /[0-9]/.test(char)))) return null;
  }
  return null;
}

/** The EXPLAIN the agent writes before a statement, for each database: whether it analyzes, by its prefix. */
const AGENT_PREFIXES: Record<string, [RegExp, boolean][]> = {
  sqlite: [[/^\s*EXPLAIN\s+QUERY\s+PLAN\s+/i, false]],
  postgresql: [
    [/^\s*EXPLAIN\s+\(ANALYZE,\s*BUFFERS\)\s+/i, true],
    [/^\s*EXPLAIN\s+/i, false],
  ],
  mysql: [
    [/^\s*EXPLAIN\s+ANALYZE\s+/i, true],
    [/^\s*EXPLAIN\s+/i, false],
  ],
};

/**
 * What the agent asks to run, checked: the EXPLAIN it wrote for this database before an explainable statement. Throws
 * with the reason otherwise; the agent's console shows it.
 */
export function checkExplain(sql: string, vendor: string): void {
  for (const [prefix, analyze] of AGENT_PREFIXES[vendor] ?? []) {
    const match = prefix.exec(sql);
    if (!match) continue;
    const refusal = explainRefusal(sql.slice(match[0].length), analyze);
    if (refusal) throw new Error(refusal);
    return;
  }
  throw new Error(NOT_SELECT);
}
