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
  const scriptAttrs =
    page && consoleUrl
      ? {
          src: `${consoleUrl}widget.min.js`,
          "data-tracepanel-api": consoleUrl,
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

/** The tag first in <head>, so the widget wraps fetch before the page's scripts keep a reference to it. */
export function inject(page: string, tag: string): string {
  const head = /<head[^>]*>/i.exec(page);
  if (head) return page.slice(0, head.index + head[0].length) + tag + page.slice(head.index + head[0].length);
  const body = page.toLowerCase().lastIndexOf("</body>");
  return body >= 0 ? page.slice(0, body) + tag + page.slice(body) : page;
}
