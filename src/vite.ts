// An SPA on Vite's dev server gets the widget, whatever serves its API (Express, Nest, Django, FastAPI):
//
//   // vite.config.ts
//   import { tracepanel } from "@tracepanel/js/vite";
//   export default { plugins: [tracepanel({ dir: "../backend" })] };
//
// index.html gets widget.min.js, and /__tracepanel__/ on Vite's own origin goes to the console of the backend
// project's agent, so the widget and its console share the page's origin. The API's responses carry their trace's
// id; across origins they expose it to the page (the SDKs do that for CORS responses).
//
// Only this machine reaches the console here, whatever address Vite listens on (`vite --host` for a phone): the
// backend sees the proxy's own address, so its own local-only checks (switching the user) would let anyone through.

import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Starter } from "./agent.js";

export interface TracepanelViteOptions {
  /** The backend project's directory, where its .tracepanel/ is. By default Vite's root and the folders above it. */
  dir?: string;
  /** The console's address itself, such as http://127.0.0.1:8765/ (`tracepanel dev`). TRACEPANEL_CONSOLE too. */
  console?: string;
  /**
   * Record the pages in the browser too (@tracepanel/js/browser): each view, its calls with a traceparent to the
   * backend's traces, its errors and its console. On unless false; `{ service, propagateTo }` sets its options.
   */
  browser?: false | { service?: string; propagateTo?: string[] };
}

interface ViteServer {
  config: { root: string };
  middlewares: {
    use(path: string, handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void;
  };
}

interface Plugin {
  name: string;
  apply: "serve";
  configureServer(server: ViteServer): void;
  transformIndexHtml(): {
    tag: string;
    attrs: Record<string, string | boolean>;
    children?: string;
    injectTo: "head-prepend";
  }[];
}

const PREFIX = "/__tracepanel__/";
// The browser recording, served from this package by the plugin itself: the console doesn't have it.
const BROWSER = fileURLToPath(new URL("./browser.js", import.meta.url));

/** The console's address: given, or what the project's agent wrote in .tracepanel/console.addr. */
function consoleAddress(options: TracepanelViteOptions, root: string): string | undefined {
  const given = options.console ?? process.env.TRACEPANEL_CONSOLE;
  if (given) return given;
  const starts = options.dir ? [resolve(root, options.dir)] : [root];
  for (const start of starts) {
    let folder = start;
    for (;;) {
      const file = join(folder, process.env.TRACEPANEL_DIR ?? ".tracepanel", "console.addr");
      if (existsSync(file)) return readFileSync(file, "utf8").trim() || undefined;
      const parent = dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
  return undefined;
}

/** A client on this machine: the console's traces, and what it lets a local caller do, are for its developer only. */
function isLocal(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/**
 * Where the backend project keeps its store, for an agent the plugin starts itself: its `dir`, else Vite's root. None
 * when the console is given (a backend that serves its own, as Django does, starts its agent itself).
 */
function storeDir(options: TracepanelViteOptions, root: string): string | undefined {
  if (options.console ?? process.env.TRACEPANEL_CONSOLE) return undefined;
  return resolve(root, options.dir ?? ".", process.env.TRACEPANEL_DIR ?? ".tracepanel");
}

/**
 * The request, sent on to the console as it came, and its answer back. A GET the agent doesn't answer (its address
 * left over from one that exited) goes once more to what `restart` gives: a new agent's console.
 */
function forward(target: URL, req: IncomingMessage, res: ServerResponse, restart?: () => string | undefined): void {
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

// Scripts Vite serves for itself: its client and env (/@vite/), React's refresh runtime (/@react-refresh).
const VITE_SOURCES = ["/@vite/", "/@react-refresh"];

export function tracepanel(options: TracepanelViteOptions = {}): Plugin {
  let starter: Starter | undefined;
  /** The project's agent, started as the SDKs start it (`gone`: the one at its address didn't answer); its console. */
  const started = (root: string, gone: boolean): string | undefined => {
    const store = storeDir(options, root);
    if (!store) return undefined;
    starter ??= new Starter(store);
    return starter.ensure(gone) ? consoleAddress(options, root) : undefined;
  };
  return {
    name: "tracepanel",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(PREFIX, (req, res) => {
        if (!isLocal(req)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("The Tracepanel console answers on this machine only.");
          return;
        }
        if (req.url === "/browser.js") {
          res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
          res.end(readFileSync(BROWSER));
          return;
        }
        const root = server.config.root;
        // No agent yet (the backend starts it on its first request): the page's first load starts it here instead.
        const address = consoleAddress(options, root) ?? started(root, false);
        if (!address) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("No Tracepanel console yet: start the backend in development, or set the plugin's console.");
          return;
        }
        forward(new URL(address), req, res, () => started(root, true));
      });
    },
    transformIndexHtml() {
      const widget = {
        tag: "script",
        attrs: { src: `${PREFIX}widget.min.js`, "data-tracepanel-api": PREFIX, defer: true },
        injectTo: "head-prepend" as const,
      };
      if (options.browser === false) return [widget];
      // The dev server's own client logs (HMR, its connection) aren't the page's: by where they come from.
      const settings = JSON.stringify({ api: PREFIX, ignoreSources: VITE_SOURCES, ...options.browser });
      const recording = {
        tag: "script",
        attrs: { type: "module" },
        children: `import { record } from "${PREFIX}browser.js"; record(${settings});`,
        injectTo: "head-prepend" as const,
      };
      return [recording, widget];
    },
  };
}
