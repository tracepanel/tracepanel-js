// The limits the agent finds the issues with, from TRACEPANEL_* variables: one per database too, by its db.system.

import { describe, expect, it } from "vitest";
import { hello } from "../src/agent.js";
import { loadConfig } from "../src/config.js";

describe("thresholds", () => {
  it("are the agent's defaults without a variable", () => {
    expect(loadConfig({}).thresholds).toEqual({
      n_plus_one: 3,
      n_plus_one_min_ms: 5,
      slow_sql_ms: 100,
      slow_http_ms: 500,
      long_transaction_ms: 500,
      queue_wait_ms: 1000,
      large_result_rows: 1000,
    });
  });

  it("take one limit per database, by its db.system, and send the maps in the hello", () => {
    const config = loadConfig({
      TRACEPANEL_SLOW_SQL_MS: "200, Snowflake=3000,bigquery=2500",
      TRACEPANEL_LONG_TRANSACTION_MS: "snowflake=20000",
      TRACEPANEL_SLOW_HTTP_MS: "700",
    });

    expect(hello(config).thresholds).toEqual({
      n_plus_one: 3,
      n_plus_one_min_ms: 5,
      slow_sql_ms: 200,
      slow_sql_ms_by_db: { snowflake: 3000, bigquery: 2500 },
      slow_http_ms: 700,
      long_transaction_ms: 500,
      long_transaction_ms_by_db: { snowflake: 20000 },
      queue_wait_ms: 1000,
      large_result_rows: 1000,
    });
  });

  it("leave out a part that isn't a number, and a per-database one where none is taken", () => {
    const config = loadConfig({
      TRACEPANEL_SLOW_SQL_MS: "abc,snowflake=,=300,duckdb=x,clickhouse=-1",
      TRACEPANEL_SLOW_HTTP_MS: "snowflake=3000",
    });

    expect(config.thresholds).toEqual({
      n_plus_one: 3,
      n_plus_one_min_ms: 5,
      slow_sql_ms: 100,
      slow_http_ms: 500,
      long_transaction_ms: 500,
      queue_wait_ms: 1000,
      large_result_rows: 1000,
    });
  });
});

describe("bodies", () => {
  it("are kept up to 64 KiB by default", () => {
    const config = loadConfig({});

    expect([config.captureBody, config.maxBodyKb]).toEqual([true, 64]);
  });

  it("follow TRACEPANEL_CAPTURE_BODY and TRACEPANEL_MAX_BODY_KB, as the Python SDK's settings", () => {
    const config = loadConfig({ TRACEPANEL_CAPTURE_BODY: "0", TRACEPANEL_MAX_BODY_KB: "8" });

    expect([config.captureBody, config.maxBodyKb]).toEqual([false, 8]);
  });

  it("keep the default for a size that isn't one", () => {
    expect(loadConfig({ TRACEPANEL_MAX_BODY_KB: "-1" }).maxBodyKb).toBe(64);
    expect(loadConfig({ TRACEPANEL_MAX_BODY_KB: "big" }).maxBodyKb).toBe(64);
  });
});
