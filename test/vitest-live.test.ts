// The Vitest plugin end to end: Vitest runs test/vitest's tests (pg on a real Postgres) under the plugin, with the
// real agent finding the issues in their traces. It runs when TRACEPANEL_TEST_POSTGRES names a Postgres
// (postgres://shop:secret@127.0.0.1:5432/shop).
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const POSTGRES = process.env.TRACEPANEL_TEST_POSTGRES;
const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const VITEST = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

let store: string;
let agent: ChildProcess | undefined;

beforeAll(async () => {
  if (!POSTGRES) return;
  store = mkdtempSync(join(tmpdir(), "tracepanel-vitest-live-"));
  // The project's agent, started here so that the test stops it: the plugin finds it answering.
  const binary = (require("@tracepanel/agent") as { binaryPath(): string }).binaryPath();
  agent = spawn(binary, ["--dir", store, "--serve", "127.0.0.1:0", "--idle-exit", "120"], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(store, "console.addr")) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
}, 15_000);

afterAll(() => {
  agent?.kill();
  if (store) rmSync(store, { recursive: true, force: true });
});

interface Run {
  output: string;
  results: [string, string, string][];
}

/** Vitest on test/vitest, as a project runs it: each test's name, outcome and failure, links made comparable. */
function vitest(env: Record<string, string>): Promise<Run> {
  const report = join(store, `report-${Object.keys(env).join("-") || "agent"}.json`);
  // The outer run's own Vitest variables would make the inner one think it is a worker.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(VITEST|TRACEPANEL_)/.test(name)),
  );
  const args = [VITEST, "run", "--config", "test/vitest/vitest.config.ts", "--reporter=default", "--reporter=json"];
  return new Promise((done) => {
    execFile(
      process.execPath,
      [...args, `--outputFile.json=${report}`],
      {
        cwd: REPOSITORY,
        env: { ...inherited, TRACEPANEL_TEST_POSTGRES: POSTGRES, TRACEPANEL_DIR: store, NO_COLOR: "1", ...env },
      },
      (_error, stdout, stderr) => {
        const json = JSON.parse(readFileSync(report, "utf8")) as {
          testResults: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
        };
        const results = (json.testResults[0]?.assertionResults ?? []).map((result): [string, string, string] => [
          result.fullName,
          result.status,
          (result.failureMessages[0] ?? "")
            .split("\n")
            // The stack's frames, not the queries' lines (`at src/books.ts:12 in list`).
            .filter((line) => !/^ {4}at .+:\d+:\d+\)?$/.test(line))
            .join("\n")
            .replace(/http:\/\/127\.0\.0\.1:\d+\/#\/t\/\w{26}/g, "<console>/#/t/<id>"),
        ]);
        done({ output: `${stdout}${stderr}`, results });
      },
    );
  });
}

/** `test/vitest/library.ts:<line>`: the line of the app that runs this statement (`nth`: the one after so many). */
function at(statement: string, nth = 0): string {
  const lines = readFileSync(new URL("./vitest/library.ts", import.meta.url), "utf8").split("\n");
  const found = lines.flatMap((text, index) => (text.includes(statement) ? [index + 1] : []));
  return `test/vitest/library.ts:${found[nth]}`;
}

const N_PLUS_ONE = [
  "N+1: 4 similar queries · SELECT vitest_authors",
  "  SELECT name FROM vitest_authors WHERE id = $1",
  `  at ${at("FROM vitest_authors WHERE id")} in booksOneByOne`,
];
const N_PLUS_ONE_HINT =
  "  Load the related rows with the parent rows (a join, or one batched query) instead of one query per row.";
const TOO_MANY = [
  "AssertionError: 5 queries, at most 2 expected:",
  "  SELECT id, title, author_id FROM vitest_books ORDER BY id",
  `    at ${at("FROM vitest_books ORDER BY id")} in booksOneByOne`,
  ...Array.from({ length: 4 }, () => [
    "  SELECT name FROM vitest_authors WHERE id = $1",
    `    at ${at("FROM vitest_authors WHERE id")} in booksOneByOne`,
  ]).flat(),
].join("\n");
const OWN_FAILURE = "AssertionError: expected 1 to be 2 // Object.is equality";
const MISSPELLED =
  "TracepanelUsageError: allow: unknown kind n+2 (the kinds: n+1, duplicates, slow-sql, slow-http, slow-call, " +
  "error, long-transaction, in-transaction, htmx, queue-wait, blocking-call, large-result)";

test.skipIf(!POSTGRES)(
  "an N+1 or duplicate queries fail the test, with what the agent found and where",
  async () => {
    const { output, results } = await vitest({});

    expect(output).toMatch(
      /^tracepanel: each test a trace · fails on duplicates, n\+1 · console http:\/\/127\.0\.0\.1:\d+\/$/m,
    );

    expect(results).toEqual([
      [
        "an N+1 fails the test",
        "failed",
        [
          "AssertionError: tracepanel found 1 issue in this test:",
          "",
          ...N_PLUS_ONE,
          N_PLUS_ONE_HINT,
          "",
          "The test's trace: <console>/#/t/<id>",
          `Allowed here with the test's option { meta: { tracepanel: { allow: ["n+1"] } } }.`,
        ].join("\n"),
      ],
      [
        "duplicate queries fail the test",
        "failed",
        [
          "AssertionError: tracepanel found 1 issue in this test:",
          "",
          "Duplicate queries: 2 identical · SELECT COUNT vitest_books",
          "  SELECT count(*) FROM vitest_books WHERE title = $1",
          `  at ${at("WHERE title = $1")} in countTwice`,
          "  Run the query once and reuse the result, or cache it for the request.",
          "",
          "The test's trace: <console>/#/t/<id>",
          `Allowed here with the test's option { meta: { tracepanel: { allow: ["duplicates"] } } }.`,
        ].join("\n"),
      ],
      ["one query passes", "passed", ""],
      ["an N+1 the test allows passes", "passed", ""],
      ["allowed in the suite an N+1 in a suite that allows it passes", "passed", ""],
      ["allowed in the suite the test's own maxQueries is over the suite's allow", "failed", TOO_MANY],
      ["maxQueries() fails the block that makes more", "failed", TOO_MANY],
      [
        "an N+1 in a request the test made fails it",
        "failed",
        [
          "AssertionError: tracepanel found 1 issue in this test:",
          "",
          ...N_PLUS_ONE,
          "  in GET /books → <console>/#/t/<id>",
          N_PLUS_ONE_HINT,
          "",
          "The test's trace: <console>/#/t/<id>",
          `Allowed here with the test's option { meta: { tracepanel: { allow: ["n+1"] } } }.`,
        ].join("\n"),
      ],
      ["a test that fails on its own fails with its own error", "failed", OWN_FAILURE],
      ["a misspelled kind fails the test", "failed", MISSPELLED],
    ]);
  },
  60_000,
);

test.skipIf(!POSTGRES)(
  "without an agent the tests run, one warning says so, and query counts still fail",
  async () => {
    const { output, results } = await vitest({ TRACEPANEL_AGENT: "off" });

    expect(output.match(/^tracepanel: .*$/gm)).toEqual([
      "tracepanel: each test a trace · fails on duplicates, n+1 · no agent: findings not checked",
      "tracepanel: the agent is off (TRACEPANEL_AGENT=off). The tests run without the agent's findings.",
    ]);

    expect(results.map(([name, status]) => [name, status])).toEqual([
      ["an N+1 fails the test", "passed"],
      ["duplicate queries fail the test", "passed"],
      ["one query passes", "passed"],
      ["an N+1 the test allows passes", "passed"],
      ["allowed in the suite an N+1 in a suite that allows it passes", "passed"],
      ["allowed in the suite the test's own maxQueries is over the suite's allow", "failed"],
      ["maxQueries() fails the block that makes more", "failed"],
      ["an N+1 in a request the test made fails it", "passed"],
      ["a test that fails on its own fails with its own error", "failed"],
      ["a misspelled kind fails the test", "failed"],
    ]);
  },
  60_000,
);
