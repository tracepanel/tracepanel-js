// fetch() as the app calls it. Node's undici starts the call's span from inside fetch, where none of the app's code is
// on the stack: the app's line is taken here, as the call is made, and handed to the span in its context.

import { context, createContextKey, trace } from "@opentelemetry/api";
import { origin } from "./stack.js";

/** The app's line that made the call (`file:line in function`), in the context of the call. */
export const CALL_ORIGIN = createContextKey("tracepanel.call_origin");

const WRAPPED = Symbol.for("tracepanel.fetch");

type Fetch = (...args: never[]) => Promise<Response>;

/** The fetch, taking the app's line as it is called. */
export function wrapFetch<F extends Fetch>(fetch: F, root: string): F {
  if ((fetch as { [WRAPPED]?: boolean })[WRAPPED]) return fetch;
  const wrapped = function (this: unknown, ...args: Parameters<F>) {
    const found = trace.getActiveSpan() ? origin(root) : null;
    if (!found) return fetch.apply(this, args);
    return context.with(context.active().setValue(CALL_ORIGIN, found), () => fetch.apply(this, args));
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped as unknown as F;
}

/** globalThis.fetch, wrapped once per process. */
export function traceFetch(root: string): void {
  if (typeof globalThis.fetch !== "function") return;
  globalThis.fetch = wrapFetch(globalThis.fetch, root);
}
