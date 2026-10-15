// EXPLAIN for the agent's console: the agent writes the statement and sends it down the connection the traces go up
// (agent.ts); this runs it on the app's database and answers with the rows, which the agent reads as a plan.
//
// The app's databases are the ones its queries ran on: each pg or mysql2 connection that queries is remembered by
// its settings (the password among them), and EXPLAIN opens one of its own with them, so it never runs inside the
// app's transaction. Whatever EXPLAIN ANALYZE does is rolled back.

import { InstrumentationBase, InstrumentationNodeModuleDefinition } from "@opentelemetry/instrumentation";

/** What the agent asks: the EXPLAIN to run, its parameters, and which database (the span's). */
export interface ExplainRequest {
  sql: string;
  params: unknown[];
  vendor: string;
  server?: string | null;
  port?: number | null;
  database?: string | null;
}

export interface ExplainAnswer {
  columns: string[];
  rows: unknown[][];
}

interface Session {
  run(sql: string, params: unknown[]): Promise<ExplainAnswer>;
  close(): Promise<void>;
}

/** A database the app queried: where it is, and how to open a session of its own there. */
interface Database {
  vendor: "postgresql" | "mysql";
  server: string;
  port: number;
  database: string;
  open(): Promise<Session>;
}

const DATABASES = new Map<string, Database>();

function remember(database: Database): void {
  const key = `${database.vendor} ${database.server}:${database.port}/${database.database}`;
  if (!DATABASES.has(key)) DATABASES.set(key, database);
}

/** The database a span's query ran on: by vendor, server, port and name; the only one of that vendor otherwise. */
function databaseFor(request: ExplainRequest): Database | undefined {
  const vendor = request.vendor === "mariadb" ? "mysql" : request.vendor;
  const candidates = [...DATABASES.values()].filter((database) => database.vendor === vendor);
  const exact = candidates.find(
    (database) =>
      (request.server == null || database.server === request.server) &&
      (request.port == null || database.port === Number(request.port)) &&
      (request.database == null || database.database === request.database),
  );
  return exact ?? (candidates.length === 1 ? candidates[0] : undefined);
}

export async function explain(request: ExplainRequest): Promise<ExplainAnswer> {
  const database = databaseFor(request);
  if (!database) throw new Error(`The app has queried no ${request.vendor} database it can run EXPLAIN on.`);
  const session = await database.open();
  try {
    await session.run("BEGIN", []);
    return await session.run(request.sql, request.params);
  } finally {
    await session.run("ROLLBACK", []).catch(() => undefined);
    await session.close();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the drivers' own types are the app's, not this package's.
type Any = any;
const MARK = Symbol.for("tracepanel.explain");

/** Records pg's and mysql2's connections as they query: where they are, and their settings. */
export class DatabasesInstrumentation extends InstrumentationBase {
  constructor() {
    super("tracepanel-databases", "1.0.0", {});
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition("pg", [">=8"], (exports: Any) => {
        this.watch(exports.Client?.prototype, (client: Any) => rememberPg(client));
        return exports;
      }),
      new InstrumentationNodeModuleDefinition("mysql2", [">=3"], (exports: Any) => {
        this.watch(exports.Connection?.prototype, (client: Any) => rememberMysql(client, exports));
        return exports;
      }),
    ];
  }

  /**
   * `query` on `proto` notes the connection first. The OpenTelemetry instrumentation wraps it too, so a wrapper of
   * its own is told by a mark, not by isWrapped.
   */
  private watch(proto: Any, note: (client: Any) => void): void {
    if (!proto || typeof proto.query !== "function" || proto.query[MARK]) return;
    const original = proto.query;
    const watched = function (this: Any, ...args: unknown[]) {
      try {
        note(this);
      } catch {
        // Never in the way of the app's query.
      }
      return original.apply(this, args);
    };
    Object.defineProperty(watched, MARK, { value: true });
    proto.query = watched;
  }
}

function rememberPg(client: Any): void {
  const params = client?.connectionParameters;
  const Client = client?.constructor;
  if (!params || typeof Client !== "function") return;
  remember({
    vendor: "postgresql",
    server: String(params.host ?? "localhost"),
    port: Number(params.port ?? 5432),
    database: String(params.database ?? ""),
    async open() {
      // Field by field: pg keeps the password a property the spread leaves out.
      const session = new Client({
        user: params.user,
        password: params.password,
        host: params.host,
        port: params.port,
        database: params.database,
        ssl: params.ssl,
      });
      await session.connect();
      return {
        async run(sql, values) {
          const result = await session.query({ text: sql, values, rowMode: "array" });
          return { columns: (result.fields ?? []).map((field: Any) => String(field.name)), rows: result.rows ?? [] };
        },
        close: () => session.end(),
      };
    },
  });
}

function rememberMysql(connection: Any, mysql2: Any): void {
  const config = connection?.config;
  if (!config || typeof mysql2.createConnection !== "function") return;
  const settings = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    socketPath: config.socketPath,
    ssl: config.ssl,
  };
  remember({
    vendor: "mysql",
    server: String(config.host ?? "localhost"),
    port: Number(config.port ?? 3306),
    database: String(config.database ?? ""),
    async open() {
      const session = mysql2.createConnection(settings);
      const query = (sql: string, values: unknown[]) =>
        new Promise<ExplainAnswer>((resolve, reject) => {
          session.query({ sql, rowsAsArray: true }, values, (error: Error | null, rows: Any, fields: Any) => {
            if (error) reject(error);
            else
              resolve({
                columns: (fields ?? []).map((field: Any) => String(field.name)),
                rows: Array.isArray(rows) ? rows : [],
              });
          });
        });
      return {
        run: query,
        close: () => new Promise<void>((resolve) => session.end(() => resolve())),
      };
    },
  });
}
