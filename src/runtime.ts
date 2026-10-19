// The one Tracepanel of the process: register.ts sets it up, the framework modules use it.

import { ConsoleUrl, Sender, Starter } from "./agent.js";
import type { BrowserOptions } from "./browser.js";
import { type Config, loadConfig } from "./config.js";
import { TracepanelProcessor } from "./processor.js";
import { type Badge, type BadgeRequest, badge } from "./widget.js";

export interface Runtime {
  config: Config;
  processor: TracepanelProcessor;
  starter: Starter;
  console: ConsoleUrl;
  /**
   * The active request's headers and script tag. On the shared object so that code bundled apart from the SDK's
   * OpenTelemetry (a Next.js layout) can read it without importing any of it.
   */
  badge(request: BadgeRequest): Badge | undefined;
  /**
   * The console on the app's own origin (Next.js serves it at /__tracepanel__/): where the widget loads from, and the
   * page's recording as an inline script. Unset where the widget loads from the agent's own address.
   */
  onOrigin?: { prefix: string; recording(options: BrowserOptions): string };
}

const KEY = Symbol.for("tracepanel.runtime");
type Holder = { [KEY]?: Runtime };

/** The process's Tracepanel, made on first use; undefined outside development. */
export function runtime(): Runtime | undefined {
  const holder = globalThis as Holder;
  if (holder[KEY]) return holder[KEY];
  const config = loadConfig();
  if (!config.enabled) return undefined;
  const starter = new Starter(config.storeDir);
  const processor = new TracepanelProcessor(config, new Sender(config, starter));
  const made: Runtime = {
    config,
    processor,
    starter,
    console: new ConsoleUrl(config.storeDir),
    badge: (request) => badge(made, request),
  };
  holder[KEY] = made;
  return made;
}
