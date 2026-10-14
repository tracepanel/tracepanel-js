#!/usr/bin/env node
// A stand-in for tracepanel-agent in the tests, started as the SDK starts the real one (--dir, --serve): it writes
// its addresses where the SDK reads them, and its console answers with the path it was asked. FAKE_AGENT_FAIL=1: it
// exits at once, an agent that can't start.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

if (process.env.FAKE_AGENT_FAIL === "1") process.exit(1);
const dir = process.argv[process.argv.indexOf("--dir") + 1];
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`console ${req.url}`);
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(join(dir, "console.addr"), `http://127.0.0.1:${port}/\n`);
  writeFileSync(join(dir, "agent.addr"), `tcp:127.0.0.1:${port}\n`);
});
// Its own session, as the real one: a test stops it by its pid.
setTimeout(() => process.exit(0), 60_000).unref();
