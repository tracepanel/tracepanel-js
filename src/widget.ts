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
}

/** The headers and the script tag for the active request, or undefined outside one. */
export function badge(
  tracepanel: Runtime,
  request: { method: string; status: number; startedMs: number; page: boolean; framework: string },
): Badge | undefined {
  const { method, status, startedMs, page, framework } = request;
  const timing = tracepanel.processor.timing();
  if (!timing) return undefined;
  let consoleUrl = tracepanel.console.get();
  if (!consoleUrl && page && tracepanel.starter.ensure()) {
    // The first page of a fresh project: its agent is starting (once), so the page gets the widget too.
    consoleUrl = tracepanel.console.get();
  }
  const totalMs = performance.now() - startedMs;
  const noun = timing.queries === 1 ? "query" : "queries";
  const headers: Record<string, string> = {
    "Tracepanel-Id": timing.id,
    // The agent finds the issues: the widget asks the console for them once the trace is stored.
    "Server-Timing": `db;dur=${timing.dbMs.toFixed(1)};desc="${timing.queries} ${noun}", app;dur=${Math.max(totalMs - timing.dbMs, 0).toFixed(1)}, total;dur=${totalMs.toFixed(1)}, tracepanel-issues;desc="pending"`,
  };
  if (consoleUrl) headers["Tracepanel-Url"] = `${consoleUrl}#/t/${timing.id}`;
  const api = escapeHtml(consoleUrl);
  const script =
    page && consoleUrl
      ? `<script src="${api}widget.min.js" data-tracepanel-api="${api}" data-tracepanel-id="${timing.id}" ` +
        `data-tracepanel-method="${escapeHtml(method)}" data-tracepanel-status="${status}" ` +
        `data-tracepanel-total="${totalMs.toFixed(1)}" data-tracepanel-db="${timing.dbMs.toFixed(1)}" ` +
        `data-tracepanel-queries="${timing.queries}" data-tracepanel-issues="pending" ` +
        `data-tracepanel-runtime="${escapeHtml(runtimeLabel(framework))}"></script>`
      : undefined;
  return { headers, script };
}

/** The tag first in <head>, so the widget wraps fetch before the page's scripts keep a reference to it. */
export function inject(page: string, tag: string): string {
  const head = /<head[^>]*>/i.exec(page);
  if (head) return page.slice(0, head.index + head[0].length) + tag + page.slice(head.index + head[0].length);
  const body = page.toLowerCase().lastIndexOf("</body>");
  return body >= 0 ? page.slice(0, body) + tag + page.slice(body) : page;
}
