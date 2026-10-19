// The console on the app's own origin, at /__tracepanel__/, in development: the Vite plugin and Next.js send what comes
// there on to the console of the project's agent, so the widget, the page's recording and the panel share the page's
// origin. Only this machine reaches it: the agent sees the proxy's own address, so its local-only checks (switching
// the user) would let anyone through.

import { readFileSync } from "node:fs";
import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
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

/**
 * The request, sent on to the console as it came, and its answer back. A GET the agent doesn't answer (its address
 * left over from one that exited) goes once more to what `restart` gives: a new agent's console.
 */
export function forward(
  target: URL,
  req: IncomingMessage,
  res: ServerResponse,
  restart?: () => string | undefined,
): void {
  const upstream = request(
    {
      host: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname.replace(/\/$/, "")}${req.url ?? "/"}`,
      headers: { ...req.headers, host: target.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    const again = req.method === "GET" ? restart?.() : undefined;
    if (again) {
      forward(new URL(again), req, res);
      return;
    }
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Tracepanel's agent doesn't answer: is the backend running in development?");
  });
  req.pipe(upstream);
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
