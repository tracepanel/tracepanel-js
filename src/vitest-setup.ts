// Each test file's setup under Tracepanel's Vitest plugin (vitest.ts): Tracepanel on in the test's process, and each
// test a trace, failed by what the agent finds in it. Vitest runs it before the file's own imports, so the database
// drivers the tests load are instrumented.

import { createRequire } from "node:module";
import { aroundEach, inject, type TestContext } from "vitest";
import { start } from "./setup.js";
import {
  Console,
  DEFAULT_FAIL_ON,
  failure,
  problems,
  type Rules,
  TestSink,
  TracedTest,
  UsageError,
} from "./testing.js";
import { rules } from "./vitest.js";

// On as `tracepanel run` turns it on, a TRACEPANEL_* variable still over it; the widget would change the pages the
// tests read.
if (!process.env.TRACEPANEL_ENABLED) process.env.TRACEPANEL_ENABLED = "1";
if (!process.env.TRACEPANEL_WIDGET) process.env.TRACEPANEL_WIDGET = "0";

const WRAPPED = Symbol.for("tracepanel.testSink");

type Task = TestContext["task"];

/** What the test failed with: not a skip, nor an expected failure. */
function errorsOf(task: Task): readonly unknown[] {
  return task.fails ? [] : (task.result?.errors ?? []);
}

const tracepanel = start();
if (tracepanel) {
  // Vitest loaded node:http before the instrumentation went in: required now, it is patched for the servers the tests
  // start (their requests' traces) and the calls they make.
  const require = createRequire(import.meta.url);
  for (const name of ["node:http", "node:https"]) require(name);
  const { processor } = tracepanel;
  // Without the plugin (the setup file named by hand): its defaults, and no agent.
  const provided = inject("tracepanel") ?? { failOn: [...DEFAULT_FAIL_ON], console: "" };
  const sink = processor.sink as typeof processor.sink & { [WRAPPED]?: boolean };
  if (!sink[WRAPPED]) processor.sink = Object.assign(new TestSink(sink, provided.console !== ""), { [WRAPPED]: true });
  const failOn = new Set(provided.failOn);

  aroundEach(async (runTest, { task }) => {
    let found: Rules;
    try {
      found = rules(task, failOn);
    } catch (error) {
      // The test's own rules: its failure, not the run's.
      if (error instanceof UsageError) throw failure(error.message, error.name);
      throw error;
    }
    const name = `${task.file.name} > ${task.fullTestName}`;
    const attrs = {
      "test.case.name": name,
      "code.filepath": task.file.name,
      "code.lineno": task.location?.line ?? 0,
      "code.function": task.name,
    };
    // The agent's console as it is now: an agent started anew listens on a new port.
    const url = provided.console ? tracepanel.console.get(true) : "";
    const run = new TracedTest(name, attrs, processor, url ? new Console(url) : undefined);
    await run.record(runTest, () => errorsOf(task));
    if (errorsOf(task).length > 0 || task.result?.state === "skip") return;
    const failed = await problems(
      run,
      found,
      (allow) => `Allowed here with the test's option { meta: { tracepanel: { allow: [${allow}] } } }.`,
    );
    if (failed.length > 0) throw failure(failed.join("\n\n"));
  });
}
