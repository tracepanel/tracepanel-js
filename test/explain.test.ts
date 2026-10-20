// EXPLAIN for the agent's console: the agent asks down the connection the traces go up, the SDK runs it on a session
// of its own with the settings of the app's connection, rolls back, and answers with the rows.
import { createServer, type Socket } from "node:net";
import { afterEach, expect, test } from "vitest";
import { Sender, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { DatabasesInstrumentation, explain } from "../src/explain.js";
import type { Trace } from "../src/model.js";

/** pg's Client as far as the SDK uses it: its settings, and every statement each instance ran. */
class FakeClient {
  static ran: { config: Record<string, unknown>; sql: string; values: unknown[] }[] = [];
  connectionParameters: Record<string, unknown>;

  constructor(config: Record<string, unknown>) {
    // As pg keeps them: the password not enumerable.
    const { password, ...rest } = config;
    this.connectionParameters = { ...rest };
    Object.defineProperty(this.connectionParameters, "password", { value: password, enumerable: false });
  }

  async connect(): Promise<void> {}

  query(query: { text: string; values?: unknown[] } | string): Promise<unknown> {
    const sql = typeof query === "string" ? query : query.text;
    FakeClient.ran.push({
      // The password too: the session EXPLAIN opens has to have it.
      config: { ...this.connectionParameters, password: this.connectionParameters["password"] },
      sql,
      values: typeof query === "string" ? [] : (query.values ?? []),
    });
    return Promise.resolve(
      sql.startsWith("EXPLAIN") ? { fields: [{ name: "QUERY PLAN" }], rows: [["Seq Scan on books"]] } : { rows: [] },
    );
  }

  async end(): Promise<void> {}
}

// pg's own query, before any test's instrumentation wraps FakeClient's.
const plainQuery = FakeClient.prototype.query;

/** A Client class no instrumentation has seen: an app that loads pg in another way than the first test. */
function freshClient(): typeof FakeClient {
  return class extends FakeClient {
    override query(query: { text: string; values?: unknown[] } | string): Promise<unknown> {
      return plainQuery.call(this, query);
    }
  };
}

/** One frame: a 4-byte big-endian length, then JSON. */
function frame(body: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(body));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

afterEach(() => {
  delete process.env.TRACEPANEL_AGENT;
  FakeClient.ran = [];
});

test("the agent's EXPLAIN runs on a session of the app's database, rolled back, and its rows go back", async () => {
  // The app's pg, as the instrumentation sees it load, and one query of the app's.
  const instrumentation = new DatabasesInstrumentation();
  const [pg] = instrumentation.getModuleDefinitions();
  pg?.patch?.({ Client: FakeClient }, "8.13.0");
  const settings = { host: "db", port: 5432, database: "shop", user: "shop", password: "secret" };
  await (new FakeClient(settings) as unknown as { query(sql: string): Promise<unknown> }).query("SELECT 1");

  // The agent: takes the hello, asks for an EXPLAIN, and waits for the answer.
  let hello: Record<string, unknown> = {};
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    const agent = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf("\n");
        if (!hello.protocol && newline >= 0) {
          hello = JSON.parse(buffer.subarray(0, newline).toString());
          buffer = buffer.subarray(newline + 1);
          socket.write('{"ok":true}\n');
          socket.write(
            frame({
              id: 7,
              explain: {
                sql: "EXPLAIN SELECT * FROM books WHERE id = $1",
                params: ["3"],
                vendor: "postgresql",
                server: "db",
                port: 5432,
                database: "shop",
                analyze: false,
              },
            }),
          );
        }
        // Frames one after another: the traces sent first, then the answer.
        while (hello.protocol && buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
          const length = buffer.readUInt32BE(0);
          const body = JSON.parse(buffer.subarray(4, 4 + length).toString());
          buffer = buffer.subarray(4 + length);
          if (!Array.isArray(body)) resolve(body);
        }
      });
    });
    agent.listen(0, "127.0.0.1", () => {
      const address = agent.address();
      process.env.TRACEPANEL_AGENT = `tcp:127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const config = loadConfig({ ...process.env, TRACEPANEL_SERVICE: "shop" });
      new Sender(config, new Starter(config.storeDir)).submit({ id: "T" } as unknown as Trace);
    });
    after.push(() => agent.close());
  });

  const answer = await answered;

  // It keeps what each request carried, as it does unless TRACEPANEL_CAPTURE_REQUEST turns that off.
  expect(hello).toMatchObject({ service: "shop", capabilities: ["explain", "request"] });
  expect(answer).toEqual({ answer: 7, columns: ["QUERY PLAN"], rows: [["Seq Scan on books"]] });
  // On a session of its own, with the app's settings, inside a transaction it rolls back.
  expect(FakeClient.ran.slice(1)).toEqual([
    { config: settings, sql: "BEGIN", values: [] },
    { config: settings, sql: "EXPLAIN SELECT * FROM books WHERE id = $1", values: ["3"] },
    { config: settings, sql: "ROLLBACK", values: [] },
  ]);
});

const after: (() => void)[] = [];
afterEach(() => {
  for (const close of after.splice(0)) close();
});

test("pg loaded by its ES module's file URL is a database EXPLAIN can run on", async () => {
  // Nitro's dev server imports pg's client file by its URL: the module-level hook never sees it.
  const instrumentation = new DatabasesInstrumentation();
  const [pg] = instrumentation.getModuleDefinitions();
  const [client] = pg?.files ?? [];
  const Client = freshClient();
  client?.patch({ default: Client, [Symbol.toStringTag]: "Module" }, "8.13.0");
  // The client is wrapped once the file's other hooks are done.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const settings = { host: "nitro-db", port: 5432, database: "store", user: "shop", password: "secret" };
  await (new Client(settings) as unknown as { query(sql: string): Promise<unknown> }).query("SELECT 1");

  const answer = await explain({ sql: "EXPLAIN SELECT 1", params: [], vendor: "postgresql", server: "nitro-db" });

  expect(answer).toEqual({ columns: ["QUERY PLAN"], rows: [["Seq Scan on books"]] });
  expect(FakeClient.ran.map((ran) => [ran.config["host"], ran.sql])).toEqual([
    ["nitro-db", "SELECT 1"],
    ["nitro-db", "BEGIN"],
    ["nitro-db", "EXPLAIN SELECT 1"],
    ["nitro-db", "ROLLBACK"],
  ]);
});

test("pg handed over as an ES module's namespace is a database EXPLAIN can run on", async () => {
  const instrumentation = new DatabasesInstrumentation();
  const [pg] = instrumentation.getModuleDefinitions();
  const Client = freshClient();
  pg?.patch?.({ default: { Client }, [Symbol.toStringTag]: "Module" }, "8.13.0");
  const settings = { host: "esm-db", port: 5432, database: "store", user: "shop", password: "secret" };
  await (new Client(settings) as unknown as { query(sql: string): Promise<unknown> }).query("SELECT 1");

  const answer = await explain({ sql: "EXPLAIN SELECT 1", params: [], vendor: "postgresql", server: "esm-db" });

  expect(answer).toEqual({ columns: ["QUERY PLAN"], rows: [["Seq Scan on books"]] });
  // On that database, not on another one the app queried.
  expect(FakeClient.ran.map((ran) => ran.config["host"])).toEqual(["esm-db", "esm-db", "esm-db", "esm-db"]);
});
