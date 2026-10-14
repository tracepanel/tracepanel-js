// An SPA on Vite's dev server gets the widget, whatever serves its API (Express, Nest, Django, FastAPI):
//
//   // vite.config.ts
//   import { tracepanel } from "tracepanel/vite";
//   export default { plugins: [tracepanel({ dir: "../backend" })] };
//
// index.html gets widget.min.js, and /__tracepanel__/ on Vite's own origin goes to the console of the backend
// project's agent, so the widget and its console share the page's origin. The API's responses carry their trace's
// id; across origins they expose it to the page (the SDKs do that for CORS responses).

import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";

export interface TracepanelViteOptions {
  /** The backend project's directory, where its .tracepanel/ is. By default Vite's root and the folders above it. */
  dir?: string;
  /** The console's address itself, such as http://127.0.0.1:8765/ (`tracepanel dev`). TRACEPANEL_CONSOLE too. */
  console?: string;
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
  transformIndexHtml(): { tag: string; attrs: Record<string, string | boolean>; injectTo: "head-prepend" }[];
}

const PREFIX = "/__tracepanel__/";

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

/** The request, sent on to the console as it came, and its answer back. */
function forward(target: URL, req: IncomingMessage, res: ServerResponse): void {
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
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Tracepanel's agent doesn't answer: is the backend running in development?");
  });
  req.pipe(upstream);
}

export function tracepanel(options: TracepanelViteOptions = {}): Plugin {
  return {
    name: "tracepanel",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(PREFIX, (req, res) => {
        const address = consoleAddress(options, server.config.root);
        if (!address) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("No Tracepanel console yet: start the backend in development, or set the plugin's console.");
          return;
        }
        forward(new URL(address), req, res);
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { src: `${PREFIX}widget.min.js`, "data-tracepanel-api": PREFIX, defer: true },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
