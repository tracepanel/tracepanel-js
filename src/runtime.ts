// The one Tracepanel of the process: register.ts sets it up, the framework modules use it.

import { ConsoleUrl, Sender, Starter } from "./agent.js";
import { type Config, loadConfig } from "./config.js";
import { TracepanelProcessor } from "./processor.js";

export interface Runtime {
  config: Config;
  processor: TracepanelProcessor;
  starter: Starter;
  console: ConsoleUrl;
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
  holder[KEY] = { config, processor, starter, console: new ConsoleUrl(config.storeDir) };
  return holder[KEY];
}
