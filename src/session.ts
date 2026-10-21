// The request's session as the app left it, for the panel's Request tab, as the Python SDK records it: session.<key>,
// each value as text, cut as an error's locals are, masked under a sensitive name and at any depth below one.
//
// Only a session the app already read is recorded, from where its framework keeps it decoded: express-session's and
// cookie-session's `req.session` in Express and Nest, h3's `useSession()` in Nuxt. Nothing here decodes a cookie: a
// sealed one (iron-session, Auth.js, h3's own) takes the app's secret.

import { repr } from "./locals.js";
import type { Attrs } from "./model.js";
import { key, MASK, masked } from "./request.js";

// Keys that say who is signed in, kept as they are: Passport's `{ user }`, under a name that reads as a password's.
const PLAIN = new Set(["passport"]);
// Keys that hold what only the server may see, whatever is inside: nuxt-auth-utils' `secure`.
const MASKED = new Set(["secure"]);

function value(name: string, item: unknown): string {
  if (MASKED.has(name)) return MASK;
  return repr(PLAIN.has(name) ? "" : name, masked(item));
}

/** session.<key> of a session's entries, under a prefix of its own when there are several (session.<name>.<key>). */
export function sessionAttrs(entries: Iterable<[string, unknown]>, prefix = "session."): Attrs {
  const found: Attrs = {};
  for (const [name, item] of entries) {
    if (typeof item !== "function") found[`${prefix}${key(name)}`] = value(name, item);
  }
  return found;
}

/**
 * The session express-session or cookie-session put on an Express request, as the handler left it; none without one.
 * express-session's `cookie` is the session cookie's settings, not what the app keeps in it.
 */
export function expressSession(session: unknown): Attrs {
  if (session === null || typeof session !== "object") return {};
  const own = typeof (session as { regenerate?: unknown }).regenerate === "function";
  return sessionAttrs(Object.entries(session).filter(([name]) => !(own && name === "cookie")));
}

/** h3's sessions as the request left them (`event.context.sessions`), by name: those `useSession()` read. */
export function h3Sessions(sessions: unknown): Attrs {
  if (sessions === null || typeof sessions !== "object") return {};
  const read = Object.entries(sessions).filter(
    (entry): entry is [string, { data: object }] => typeof entry[1]?.data === "object" && entry[1].data !== null,
  );
  const named = read.length > 1;
  return Object.assign(
    {},
    ...read.map(([name, session]) =>
      sessionAttrs(Object.entries(session.data), named ? `session.${key(name)}.` : "session."),
    ),
  );
}
