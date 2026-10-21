// Traces go to the project's agent, which finds their issues, keeps them and serves the console. Its addresses are in
// <store>/agent.addr and console.addr. The wire: a hello line, then frames of a 4-byte big-endian length and a JSON
// array of traces, or an object of task events (`{"tasks": [...]}`: a queue's jobs while they are in flight). The
// agent starts on demand, as the other SDKs start it, and outlives the app's restarts.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { Config } from "./config.js";
import { type ExplainRequest, explain } from "./explain.js";
import type { Trace } from "./model.js";
import { available as canProfile } from "./profile.js";

const PROTOCOL = 1;
const QUEUE_SIZE = 1000;
const BATCH_SIZE = 50;
const BATCH_WAIT_MS = 50;
const RETRY_AFTER_MS = 5000;
const START_WAIT_MS = 1500;
const CONSOLE_CHECK_MS = 2000;
const IDLE_EXIT_S = "1800";
// An agent that exited (idle, killed, replaced by a new build) is started anew at once; one that couldn't start is
// tried again after this long, not on every trace.
const RESTART_MS = 30_000;

function readAddress(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** TRACEPANEL_AGENT (an agent outside the app's container, tcp:host:port), or the address the project's agent wrote. */
function agentAddress(storeDir: string): string {
  const named = process.env.TRACEPANEL_AGENT;
  if (named && named !== "auto") return named;
  return readAddress(join(storeDir, "agent.addr"));
}

function autoStart(): boolean {
  const named = process.env.TRACEPANEL_AGENT;
  return !named || named === "auto";
}

/** The agent's binary: TRACEPANEL_AGENT_BIN, or the one npm installed with @tracepanel/agent. */
function agentBinary(): string | undefined {
  try {
    const agent = createRequire(import.meta.url)("@tracepanel/agent") as { binaryPath(): string };
    return agent.binaryPath();
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function warn(message: string): void {
  process.stderr.write(`tracepanel: ${message}\n`);
}

/** Starts the project's agent when none answers, in its own session, serving the console on a free port. */
export class Starter {
  private failedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly storeDir: string) {}

  /**
   * Whether an agent runs for the project: one already does, or this process starts it (RESTART_MS after a failure).
   * `gone`: the agent at the project's address didn't answer. One that didn't exit cleanly (killed, a reboot) leaves
   * its addresses: they go before a new one starts.
   */
  ensure(gone = false): boolean {
    if (!gone && agentAddress(this.storeDir)) return true;
    if (!autoStart() || Date.now() - this.failedAt < RESTART_MS) return false;
    if (gone) for (const name of ["agent.addr", "console.addr"]) rmSync(join(this.storeDir, name), { force: true });
    this.start();
    const started = agentAddress(this.storeDir) !== "";
    if (!started) this.failedAt = Date.now();
    return started;
  }

  private start(): void {
    const binary = agentBinary();
    if (!binary) return;
    mkdirSync(this.storeDir, { recursive: true });
    const log = openSync(join(this.storeDir, "agent.log"), "a");
    try {
      const child = spawn(binary, ["--dir", this.storeDir, "--serve", "127.0.0.1:0", "--idle-exit", IDLE_EXIT_S], {
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.on("error", (error) => warn(`the agent didn't start: ${error.message}`));
      child.unref();
    } finally {
      closeSync(log);
    }
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline && !agentAddress(this.storeDir)) {
      // The first trace waits a moment for the agent's address: it's the one place a request waits on it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (!agentAddress(this.storeDir)) warn(`the agent didn't start (see ${join(this.storeDir, "agent.log")})`);
  }
}

/** Where the widget loads from and opens the panel: the console the project's agent serves, read every few seconds. */
export class ConsoleUrl {
  private url = "";
  private checked = 0;

  constructor(private readonly storeDir: string) {}

  /** `fresh`: read now, as a proxy to the console does for each request (a new agent listens on a new port). */
  get(fresh = false): string {
    const configured = process.env.TRACEPANEL_CONSOLE_URL;
    if (configured) return configured.endsWith("/") ? configured : `${configured}/`;
    if (fresh || !this.url || Date.now() - this.checked > CONSOLE_CHECK_MS) {
      this.checked = Date.now();
      this.url = readAddress(join(this.storeDir, "console.addr"));
    }
    return this.url;
  }
}

/**
 * A task event: a job queued, started, retried or finished, or a worker's heartbeat, with what that step knows (see
 * bullmq.ts). The console's Live list of tasks in flight is made of them, before a task's trace exists.
 */
export type TaskEvent = Record<string, unknown>;

/** What the integrations send the agent beyond traces (`live_tasks`: BullMQ's task events), as they say on load. */
const SENDS = new Set<string>();

/** Say in the hello that this app sends `name` (`live_tasks`). */
export function sends(name: string): void {
  SENDS.add(name);
}

/**
 * The first line to the agent: it finds the issues with this project's limits. What the app offers the console, said
 * here only: it can EXPLAIN a query on its database, its traces hold what each request carried while that is kept,
 * and a request that asks is profiled while profiling is on (the console's Profile toggle shows then); and what it
 * sends besides traces (`live_tasks`).
 */
export function hello(config: Config): Record<string, unknown> {
  return {
    protocol: PROTOCOL,
    max_traces: config.maxTraces,
    thresholds: config.thresholds,
    service: config.service,
    capabilities: [
      "explain",
      ...(config.captureRequest ? ["request"] : []),
      ...(config.profileEnabled && canProfile() ? ["profile"] : []),
      ...[...SENDS].sort(),
    ],
  };
}

/**
 * Batches traces and task events to the agent in the background; a full queue drops one rather than slow a request
 * down.
 */
export class Sender {
  private queue: Trace[] = [];
  private events: TaskEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private socket: Socket | undefined;
  private connecting: Promise<Socket | undefined> | undefined;
  private retryAt = 0;
  private warned = false;
  /** What the connection's hello said the app sends: a module that sends more loaded after it (bullmq) reconnects. */
  private said = "";

  constructor(
    private readonly config: Config,
    private readonly starter: Starter,
  ) {}

  submit(trace: Trace): void {
    if (this.queue.length >= QUEUE_SIZE) return;
    this.queue.push(trace);
    if (this.queue.length >= BATCH_SIZE) this.flushSoon(0);
    else this.flushSoon(BATCH_WAIT_MS);
  }

  /** A task event, sent with the next batch: not counted with the traces, and dropped while no agent answers. */
  submitEvent(event: TaskEvent): void {
    if (this.events.length >= QUEUE_SIZE) return;
    this.events.push(event);
    if (this.events.length >= BATCH_SIZE) this.flushSoon(0);
    else this.flushSoon(BATCH_WAIT_MS);
  }

  private flushSoon(delay: number): void {
    if (this.timer && delay > 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    const batch = this.queue.splice(0, BATCH_SIZE);
    const events = this.events.splice(0, BATCH_SIZE);
    if (batch.length === 0 && events.length === 0) return;
    const socket = await this.connection();
    if (!socket) return;
    if (batch.length > 0) writeFrame(socket, batch);
    if (events.length > 0) writeFrame(socket, { tasks: events });
    if (this.queue.length > 0 || this.events.length > 0) this.flushSoon(0);
  }

  private async connection(): Promise<Socket | undefined> {
    if (this.socket && !this.socket.destroyed && this.said !== saying(this.config)) {
      // The hello is the one place the app says what it sends: a new connection says it again.
      this.socket.destroy();
      this.socket = undefined;
    }
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (Date.now() < this.retryAt) return undefined;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    const socket = await this.connecting;
    if (!socket) {
      this.retryAt = Date.now() + RETRY_AFTER_MS;
      if (!this.warned && !autoStart()) {
        this.warned = true;
        warn(`no agent at ${agentAddress(this.config.storeDir)}: traces are dropped until it answers`);
      }
    }
    return socket;
  }

  private async open(): Promise<Socket | undefined> {
    let socket = await this.handshake(agentAddress(this.config.storeDir));
    if (!socket && this.starter.ensure(true)) socket = await this.handshake(agentAddress(this.config.storeDir));
    if (socket) {
      this.socket = socket;
      socket.unref();
      socket.on("error", () => socket?.destroy());
      socket.on("close", () => {
        if (this.socket === socket) this.socket = undefined;
      });
    }
    return socket;
  }

  /** A connection the agent accepted after the hello line, or undefined. */
  private handshake(address: string): Promise<Socket | undefined> {
    const target = address.startsWith("unix:")
      ? { path: address.slice("unix:".length) }
      : address.startsWith("tcp:")
        ? hostPort(address.slice("tcp:".length))
        : undefined;
    if (!target) return Promise.resolve(undefined);
    return new Promise((done) => {
      const socket = connect(target);
      const fail = () => {
        socket.destroy();
        done(undefined);
      };
      socket.setTimeout(500, fail);
      socket.once("error", fail);
      socket.once("connect", () => {
        this.said = saying(this.config);
        socket.write(`${JSON.stringify(hello(this.config))}\n`);
      });
      let received = Buffer.alloc(0);
      socket.on("data", function onData(chunk: Buffer) {
        received = Buffer.concat([received, chunk]);
        const newline = received.indexOf(10);
        if (newline < 0) return;
        socket.off("data", onData);
        socket.setTimeout(0);
        socket.removeListener("error", fail);
        const reply = JSON.parse(received.subarray(0, newline).toString("utf8")) as { ok: boolean; error?: string };
        if (reply.ok) {
          // The agent's requests come down the same connection, a frame each (EXPLAIN on the app's database): what
          // came with the answer is the start of the first.
          readFrames(socket, received.subarray(newline + 1), (request) => void answer(socket, request));
          done(socket);
        } else {
          warn(`the agent refused: ${reply.error}`);
          fail();
        }
      });
    });
  }
}

/** What a hello says the app sends, to tell when it says more. */
function saying(config: Config): string {
  return JSON.stringify(hello(config).capabilities);
}

/** One frame: a 4-byte big-endian length, then the JSON. */
function writeFrame(socket: Socket, payload: unknown): void {
  const data = Buffer.from(JSON.stringify(payload));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  socket.write(Buffer.concat([length, data]));
}

function hostPort(value: string): { host: string; port: number } {
  const at = value.lastIndexOf(":");
  return { host: value.slice(0, at).replace(/^\[|\]$/g, ""), port: Number(value.slice(at + 1)) };
}

/** Calls `onFrame` with each length-prefixed JSON frame the agent sends after the hello. */
/** What the agent asks of the app: an EXPLAIN, under the id its answer carries back. */
interface AgentRequest {
  id?: unknown;
  explain?: ExplainRequest;
}

function readFrames(socket: Socket, start: Buffer, onFrame: (frame: AgentRequest) => void): void {
  let pending = Buffer.alloc(0);
  const read = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const length = pending.readUInt32BE(0);
      const body = pending.subarray(4, 4 + length).toString("utf8");
      pending = pending.subarray(4 + length);
      try {
        onFrame(JSON.parse(body) as AgentRequest);
      } catch {
        // A frame this SDK can't read: the agent times its request out.
      }
    }
  };
  socket.on("data", read);
  read(start);
}

/** The agent's request run, and its answer sent back up: the rows, or what went wrong. */
async function answer(socket: Socket, request: AgentRequest): Promise<void> {
  if (!request.explain) return;
  let reply: Record<string, unknown>;
  try {
    reply = { answer: request.id, ...(await explain(request.explain)) };
  } catch (error) {
    reply = { answer: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  if (!socket.destroyed) writeFrame(socket, reply);
}
