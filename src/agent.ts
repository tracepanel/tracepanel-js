// Traces go to the project's agent, which finds their issues, keeps them and serves the console. Its addresses are in
// <store>/agent.addr and console.addr. The wire: a hello line, then frames of a 4-byte big-endian length and a JSON
// array of traces. The agent starts on demand, as the other SDKs start it, and outlives the app's restarts.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Trace } from "./model.js";

const PROTOCOL = 1;
const QUEUE_SIZE = 1000;
const BATCH_SIZE = 50;
const BATCH_WAIT_MS = 50;
const RETRY_AFTER_MS = 5000;
const START_WAIT_MS = 1500;
const CONSOLE_CHECK_MS = 2000;
const IDLE_EXIT_S = "1800";

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

/** Starts the project's agent at most once per process, in its own session, serving the console on a free port. */
export class Starter {
  private tried = false;

  constructor(private readonly storeDir: string) {}

  /** Whether an agent runs for the project: one already does, or this process starts it (once). */
  ensure(): boolean {
    if (agentAddress(this.storeDir)) return true;
    if (!autoStart() || this.tried) return false;
    this.tried = true;
    this.start();
    return agentAddress(this.storeDir) !== "";
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

  get(): string {
    const configured = process.env.TRACEPANEL_CONSOLE_URL;
    if (configured) return configured.endsWith("/") ? configured : `${configured}/`;
    if (!this.url || Date.now() - this.checked > CONSOLE_CHECK_MS) {
      this.checked = Date.now();
      this.url = readAddress(join(this.storeDir, "console.addr"));
    }
    return this.url;
  }
}

/** Batches traces to the agent in the background; a full queue drops a trace rather than slow a request down. */
export class Sender {
  private queue: Trace[] = [];
  private timer: NodeJS.Timeout | undefined;
  private socket: Socket | undefined;
  private connecting: Promise<Socket | undefined> | undefined;
  private retryAt = 0;
  private warned = false;

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
    if (batch.length === 0) return;
    const socket = await this.connection();
    if (!socket) return;
    const data = Buffer.from(JSON.stringify(batch));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    socket.write(Buffer.concat([length, data]));
    if (this.queue.length > 0) this.flushSoon(0);
  }

  private async connection(): Promise<Socket | undefined> {
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
    if (!socket && this.starter.ensure()) socket = await this.handshake(agentAddress(this.config.storeDir));
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
        // The agent finds the issues with this project's limits.
        const hello = { protocol: PROTOCOL, max_traces: this.config.maxTraces, thresholds: this.config.thresholds };
        socket.write(`${JSON.stringify(hello)}\n`);
      });
      let answer = "";
      socket.on("data", function onData(chunk) {
        answer += chunk.toString("utf8");
        if (!answer.includes("\n")) return;
        socket.off("data", onData);
        socket.setTimeout(0);
        socket.removeListener("error", fail);
        const reply = JSON.parse(answer.slice(0, answer.indexOf("\n"))) as { ok: boolean; error?: string };
        if (reply.ok) done(socket);
        else {
          warn(`the agent refused: ${reply.error}`);
          fail();
        }
      });
    });
  }
}

function hostPort(value: string): { host: string; port: number } {
  const at = value.lastIndexOf(":");
  return { host: value.slice(0, at).replace(/^\[|\]$/g, ""), port: Number(value.slice(at + 1)) };
}
