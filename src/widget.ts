// What a response gives the widget: the trace's id and timing in headers, and widget.min.js in an HTML page.

import { runtimeLabel } from "./processor.js";
import type { Runtime } from "./runtime.js";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface Badge {
  headers: Record<string, string>;
  /** The script tag for an HTML page, or undefined when there is no console to open. */
  script: string | undefined;
  /** The same tag's attributes, for a framework that renders the tag itself (a React component). */
  scriptAttrs: Record<string, string> | undefined;
}

export interface BadgeRequest {
  /** The request's URL: finds its trace when the response goes out outside the request's context. */
  url?: string;
  method: string;
  status: number;
  startedMs: number;
  page: boolean;
  framework: string;
}

/** The headers and the script tag for the active request, or undefined outside one. */
export function badge(tracepanel: Runtime, request: BadgeRequest): Badge | undefined {
  const { method, status, startedMs, page, framework } = request;
  const timing = tracepanel.processor.timing(
    request.url === undefined ? undefined : { method: request.method, url: request.url },
  );
  if (!timing) return undefined;
  let consoleUrl = tracepanel.console.get();
  if (!consoleUrl && page && tracepanel.starter.ensure()) {
    // The first page of a fresh project: its agent is starting (once), so the page gets the widget too.
    consoleUrl = tracepanel.console.get();
  }
  // From the request's start as the trace saw it: a framework's own server started it before any of the app's code.
  const totalMs = performance.now() - Math.min(startedMs, timing.startedMs);
  const noun = timing.queries === 1 ? "query" : "queries";
  const headers: Record<string, string> = {
    "Tracepanel-Id": timing.id,
    // The agent finds the issues: the widget asks the console for them once the trace is stored.
    "Server-Timing": `db;dur=${timing.dbMs.toFixed(1)};desc="${timing.queries} ${noun}", app;dur=${Math.max(totalMs - timing.dbMs, 0).toFixed(1)}, total;dur=${totalMs.toFixed(1)}, tracepanel-issues;desc="pending"`,
  };
  if (consoleUrl) headers["Tracepanel-Url"] = `${consoleUrl}#/t/${timing.id}`;
  // The console on the page's own origin, where the app serves it: the widget and the page's recording share it.
  const api = tracepanel.onOrigin?.prefix ?? consoleUrl;
  const scriptAttrs =
    page && consoleUrl
      ? {
          src: `${api}widget.min.js`,
          "data-tracepanel-api": api,
          "data-tracepanel-id": timing.id,
          "data-tracepanel-method": method,
          "data-tracepanel-status": String(status),
          "data-tracepanel-total": totalMs.toFixed(1),
          "data-tracepanel-db": timing.dbMs.toFixed(1),
          "data-tracepanel-queries": String(timing.queries),
          "data-tracepanel-issues": "pending",
          "data-tracepanel-runtime": runtimeLabel(framework),
        }
      : undefined;
  const script = scriptAttrs
    ? `<script ${Object.entries(scriptAttrs)
        .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
        .join(" ")}></script>`
    : undefined;
  return { headers, script, scriptAttrs };
}

const EXPOSED = ["Tracepanel-Id", "Tracepanel-Name", "Tracepanel-Url", "Server-Timing"];

/**
 * Access-Control-Expose-Headers with Tracepanel's added, for a CORS response (one with Access-Control-Allow-Origin):
 * a page on another origin, an SPA on Vite's dev server, can read the trace's id then. Undefined for other responses.
 */
export function exposedHeaders(allowOrigin: unknown, existing: unknown): string | undefined {
  if (allowOrigin === undefined || allowOrigin === null) return undefined;
  const names = String(existing ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set([...names, ...EXPOSED])].join(", ");
}

/** The tag first in <head>, so the widget wraps fetch before the page's scripts keep a reference to it. */
export function inject(page: string, tag: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(page);
  if (head) return page.slice(0, head.index + head[0].length) + tag + page.slice(head.index + head[0].length);
  const body = page.toLowerCase().lastIndexOf("</body>");
  return body >= 0 ? page.slice(0, body) + tag + page.slice(body) : page;
}

/**
 * Whether a response is an HTML page the script can go into as it streams: not compressed, its size not declared
 * (the script would change it).
 */
export function streamablePage(header: (name: string) => unknown): boolean {
  const html = String(header("content-type") ?? "").includes("text/html");
  return html && header("content-encoding") == null && header("content-length") == null;
}

// Where a streamed page gets the script: right after its <head> opens, or its <body> without one.
const OPENING = /<(?:head|body)(?:\s[^>]*)?>/i;
/** A page streamed this far without either is not one the script goes into: the rest passes as it comes. */
export const STREAM_LOOKAHEAD = 65_536;

/**
 * The script put into an HTML page that goes out in pieces, as they pass.
 *
 * Nothing is held but the end of a piece from its last `<` (a tag that may go on in the next one), until the script
 * is in.
 */
export class Stream {
  private readonly tag: Buffer;
  private held: Buffer = Buffer.alloc(0);
  private seen = 0;
  private done = false;

  constructor(tag: string) {
    this.tag = Buffer.from(tag);
  }

  /** What goes out now, of the piece and what was held. */
  feed(piece: Uint8Array): Buffer {
    const chunk = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
    if (this.done) return chunk;
    const data = this.held.length > 0 ? Buffer.concat([this.held, chunk]) : chunk;
    this.held = Buffer.alloc(0);
    // Latin-1 keeps one character per byte: the indexes found are the bytes'.
    const text = data.toString("latin1");
    const found = OPENING.exec(text);
    if (found) {
      this.done = true;
      const at = found.index + found[0].length;
      return Buffer.concat([data.subarray(0, at), this.tag, data.subarray(at)]);
    }
    this.seen += chunk.length;
    if (this.seen > STREAM_LOOKAHEAD) {
      this.done = true;
      return data;
    }
    const cut = text.lastIndexOf("<");
    if (cut === -1 || text.includes(">", cut)) return data;
    // A copy: the app may reuse the piece's memory once it is written.
    this.held = Buffer.from(data.subarray(cut));
    return data.subarray(0, cut);
  }

  /** What was held, once the body ends. */
  end(): Buffer {
    const rest = this.held;
    this.held = Buffer.alloc(0);
    this.done = true;
    return rest;
  }
}
