// The badge on a Next.js app's pages, and the recording of the pages themselves: `<Tracepanel />` in the root layout.
// A server component that reads the active request from the process's Tracepanel; no OpenTelemetry in it, so the
// layout's bundle stays as it was. Outside development it renders nothing.

import { createElement, Fragment, type ReactElement } from "react";
import type { Runtime } from "./runtime.js";

export interface TracepanelProps {
  /**
   * Record the pages in the browser too (@tracepanel/js/browser): each view and action a trace, its calls with a
   * traceparent to the server's traces, its errors and its console. On unless false; `{ service, propagateTo }` sets
   * its options.
   */
  browser?: false | { service?: string; propagateTo?: string[] };
}

const KEY = Symbol.for("tracepanel.runtime");

/** The widget's script tag for this request's page, after the page's recording; nothing outside development. */
export function Tracepanel({ browser }: TracepanelProps = {}): ReactElement | null {
  const tracepanel = (globalThis as { [KEY]?: Runtime })[KEY];
  const marks = tracepanel?.badge({
    method: "GET",
    status: 200,
    startedMs: performance.now(),
    page: true,
    framework: tracepanel.processor.framework() ?? "Next.js",
  });
  if (!marks?.scriptAttrs) return null;
  const widget = createElement("script", { ...marks.scriptAttrs, async: true });
  // The recording needs the console on the page's origin, which register() serves: inline, it runs before the app's
  // own scripts, so it wraps fetch before any of them keeps a reference to it.
  const recording =
    browser !== false && tracepanel?.onOrigin
      ? // biome-ignore lint/security/noDangerouslySetInnerHtml: this package's own script, its settings escaped for it
        createElement("script", { dangerouslySetInnerHTML: { __html: tracepanel.onOrigin.recording(browser ?? {}) } })
      : null;
  return recording ? createElement(Fragment, null, recording, widget) : widget;
}
