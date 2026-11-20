// The console on the app's own origin, at /__tracepanel__/, in development: the Vite plugin and Next.js send what comes
// there on to the console of the project's agent, so the widget, the page's recording and the panel share the page's
// origin. Only this machine reaches it: the agent sees the proxy's own address, so its local-only checks (switching
// the user) would let anyone through.

import { readFileSync } from "node:fs";
import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { NoConsole } from "./agent.js";
import type { BrowserOptions } from "./browser.js";

export const PREFIX = "/__tracepanel__/";
// The browser recording, served from this package: the console doesn't have it.
const BROWSER = fileURLToPath(new URL("./browser.js", import.meta.url));

/** A client on this machine: the console's traces, and what it lets a local caller do, are for its developer only. */
export function isLocal(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** The browser recording as an ES module, for `import { record } from "/__tracepanel__/browser.js"`. */
export function browserModule(): string {
  return readFileSync(BROWSER, "utf8");
}

/**
 * The browser recording (its ES module) as a classic script that starts it at once: inline in the page's <head>, it
 * wraps fetch before the app's own scripts run, and so before any of them keeps a reference to it.
 */
export function recordingScript(module: string, options: BrowserOptions): string {
  // Inside a <script>: no "</script>" in the settings, whatever a service is called.
  const settings = JSON.stringify(options).replace(/</g, "\\u003c");
  return `(() => {\n${module.replace(/^export /gm, "")}\nrecord(${settings});\n})();`;
}

/** What the proxy does when the console doesn't answer: `restart` gives a new agent's console, `why` says what's wrong. */
export interface Fallback {
  restart?: () => Promise<string | undefined>;
  why: () => Promise<NoConsole>;
}

/**
 * The request, sent on to the console as it came, and its answer back. A GET the agent doesn't answer (its address
 * left over from one that exited) goes once more to what `restart` gives: a new agent's console; a write, whose body
 * is gone, is asked to come again. Without a console, the answer says why (`unavailable`).
 */
export function forward(target: URL, req: IncomingMessage, res: ServerResponse, fallback: Fallback): void {
  const upstream = request(
    {
      host: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname.replace(/\/$/, "")}${req.url ?? "/"}`,
      headers: { ...req.headers, host: target.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 503, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", async () => {
    const again = await fallback.restart?.();
    if (again && req.method === "GET") {
      forward(new URL(again), req, res, { why: fallback.why });
      return;
    }
    // A write's body went to the agent that didn't answer: once a new one serves its console, the client sends it
    // again.
    const restarted = again !== undefined && new URL(again).href !== target.href;
    unavailable(req, res, restarted ? RESTARTED : await fallback.why());
  });
  req.pipe(upstream);
}

const RESTARTED: NoConsole = {
  title: "Tracepanel's agent restarted",
  detail: "Tracepanel's agent had stopped, and a new one has started: send the request again.",
};

// While the console doesn't answer: the browser asks again this often, and the page reloads itself as often.
const RETRY_S = 2;

/**
 * No console: 503 with why and what to do. A browser's page (it accepts HTML) gets a small page that reloads itself
 * until the console answers; the console's API calls and its files get `{"error": ...}`.
 */
export function unavailable(req: IncomingMessage, res: ServerResponse, why: NoConsole): void {
  const page = (req.headers.accept ?? "").includes("text/html");
  res.writeHead(503, {
    "Content-Type": page ? "text/html; charset=utf-8" : "application/json",
    "Retry-After": String(RETRY_S),
    "Cache-Control": "no-store",
  });
  res.end(page ? unavailablePage(why) : JSON.stringify({ error: why.detail }));
}

/** The page in the console's look (its dark tokens), with nothing to load: the console is what's missing. */
export function unavailablePage(why: NoConsole): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_S}">
<title>Tracepanel: ${escapeHtml(why.title)}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0c11; color: #eceef3;
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { box-sizing: border-box; max-width: 38rem; margin: 2rem 1rem; padding: 1.5rem 1.75rem; border: 1px solid #2a3040;
  border-radius: 12px; background: rgb(245 181 68 / 0.06); }
h1 { margin: 0 0 0.75rem; font-size: 1.05rem; font-weight: 600; color: #f5b544; }
p { margin: 0.5rem 0; overflow-wrap: anywhere; }
.muted { color: #8c93a6; font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(why.title)}</h1>
<p>${escapeHtml(why.detail)}</p>
<p class="muted">This page reloads itself every ${RETRY_S} seconds and shows the console once it answers.</p>
</main>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * What the proxy answers itself (the URL with the prefix taken off), true when it did: another machine is refused,
 * and the browser recording comes from this package. The rest goes on to the agent.
 */
export function answeredHere(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLocal(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("The Tracepanel console answers on this machine only.");
    return true;
  }
  if (req.url === "/browser.js") {
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    res.end(browserModule());
    return true;
  }
  return false;
}
