// The badge on a Next.js app's pages: `<Tracepanel />` in the root layout. A server component that reads the active
// request from the process's Tracepanel; no OpenTelemetry in it, so the layout's bundle stays as it was.

import { createElement, type ReactElement } from "react";
import type { Runtime } from "./runtime.js";

const KEY = Symbol.for("tracepanel.runtime");

/** The widget's script tag for this request's page, or nothing outside development. */
export function Tracepanel(): ReactElement | null {
  const tracepanel = (globalThis as { [KEY]?: Runtime })[KEY];
  const marks = tracepanel?.badge({
    method: "GET",
    status: 200,
    startedMs: performance.now(),
    page: true,
    framework: tracepanel.processor.framework() ?? "Next.js",
  });
  return marks?.scriptAttrs ? createElement("script", { ...marks.scriptAttrs, async: true }) : null;
}
