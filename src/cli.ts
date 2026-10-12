#!/usr/bin/env node
// `tracepanel run <command>`, `tracepanel dev`, `tracepanel mcp`: as the Python package's, for Node apps.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { loadConfig } from "./config.js";

const HELP = `usage: tracepanel <command>
  run <command...>   run a Node command with Tracepanel on (node --import tracepanel/register)
  dev [--port 8765]  run the agent in the foreground, with the console on http://127.0.0.1:8765/
  mcp [--values]     an MCP server for AI coding agents, on stdin and stdout`;

function agentBinary(): string {
  return (createRequire(import.meta.url)("@tracepanel/agent") as { binaryPath(): string }).binaryPath();
}

function exec(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const child = spawn(command, args, { stdio: "inherit", env });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();

if (command === "run" && args.length > 0) {
  const register = new URL("./register.js", import.meta.url).href;
  const options = [process.env.NODE_OPTIONS, `--import ${register}`].filter(Boolean).join(" ");
  exec(args[0] as string, args.slice(1), { ...process.env, NODE_OPTIONS: options, TRACEPANEL_ENABLED: "1" });
} else if (command === "dev") {
  const port = args[args.indexOf("--port") + 1] && args.includes("--port") ? args[args.indexOf("--port") + 1] : "8765";
  exec(agentBinary(), ["--dir", config.storeDir, "--serve", `127.0.0.1:${port}`]);
} else if (command === "mcp") {
  exec(agentBinary(), ["mcp", "--dir", config.storeDir, ...(args.includes("--values") ? ["--values"] : [])]);
} else {
  process.stdout.write(`${HELP}\n`);
  process.exit(command ? 2 : 0);
}
