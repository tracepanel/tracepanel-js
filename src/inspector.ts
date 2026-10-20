// Node's inspector, from inside the app: what the profiler and the error's local variables read. A session in the
// app's own thread answers each call at once, while the call is made, so both stay synchronous. Loaded on first use:
// a Node built without the inspector, and Bun, which has none to speak of, get neither feature and nothing breaks.

import { createRequire } from "node:module";

type Inspector = typeof import("node:inspector");
type Session = InstanceType<Inspector["Session"]>;

let loaded: Inspector | null | undefined;

/** node:inspector, or null where there is none. */
export function inspector(): Inspector | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.versions.bun !== undefined || !process.features.inspector) return loaded;
  try {
    loaded = createRequire(import.meta.url)("node:inspector") as Inspector;
  } catch {
    // Not in this build of Node.
  }
  return loaded;
}

/** A session with this thread's inspector, connected; undefined where there is none. */
export function connect(): Session | undefined {
  const found = inspector();
  if (!found) return undefined;
  try {
    const session = new found.Session();
    session.connect();
    return session;
  } catch {
    return undefined;
  }
}

/** A call on a session of this thread, answered before it returns: its result, or the error it failed with. */
export function call<T = Record<string, unknown>>(session: Session, method: string, params?: object): T {
  let failure: Error | null = null;
  let result: unknown;
  session.post(method, params ?? {}, (error: Error | null, answer?: unknown) => {
    failure = error;
    result = answer;
  });
  if (failure) throw failure;
  return result as T;
}

export type { Session };
