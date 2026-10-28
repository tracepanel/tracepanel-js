// `app.use(tracepanel())`, first: Hono middleware, for Hono on Node (@hono/node-server) and on Bun. The route's handler
// is a span of its own, named by its route (`/books/:id`), and so is the request's trace. On Node every response gets
// what the badge reads (Tracepanel-Id, Server-Timing) and an HTML page the widget's script, put into its body as it
// streams; what the request carried goes into its trace: its headers, query, cookies, its body as far as the handler
// read it, and the response's headers. On Bun, `withTracepanel(app.fetch)` does that, and this middleware names the
// route and its handler under it. An error is the request's unless the app answers it below 500 (an HTTPException, or
// what app.onError answers).
//
// Hono matches a request before its middleware run: the handler is the last of the routes it matched that is not
// middleware, and its span holds what runs after this middleware (the others the route has, then the handler).

import type { Context, MiddlewareHandler, Next } from "hono";
import { matchedRoutes } from "hono/route";
import { tapRequest } from "./body.js";
import { MARKED, marked } from "./respond.js";
import { runtime } from "./runtime.js";
import { inView, recordError, wasRecorded } from "./view.js";

const FRAMEWORK = "Hono";

/** The route that answers the request: the last one matched that isn't middleware (`app.use()`'s, `next` taken). */
function handlerRoute(c: Context): string | undefined {
  const routes = matchedRoutes(c);
  for (let at = routes.length - 1; at > c.req.routeIndex; at--) {
    const route = routes[at];
    if (route && (route.method !== "ALL" || route.handler.length < 2)) return route.path;
  }
  return undefined;
}

export function tracepanel(): MiddlewareHandler {
  const tp = runtime();
  return async function tracepanelMiddleware(c: Context, next: Next): Promise<void> {
    if (!tp) {
      await next();
      return;
    }
    tp.processor.setFramework(FRAMEWORK);
    const startedMs = performance.now();
    const request = c.req.raw;
    const marking = !(request as Request & { [MARKED]?: true })[MARKED];
    const body = marking && tp.config.captureRequest ? tapRequest(request) : undefined;
    const route = handlerRoute(c);
    if (route) {
      tp.processor.setRoute(route);
      // Hono catches what the handler throws, for app.onError: the error is the context's then.
      await inView(route, null, async (span) => {
        await next();
        if (c.error) recordError(span, c.error, c.res.status);
      });
    } else {
      await next();
    }
    // Thrown in middleware, before the handler or without one.
    if (c.error && c.res.status >= 500 && !wasRecorded(c.error)) tp.processor.addError(c.error);
    if (!marking) return;
    const answer = await marked(tp, request, c.res, startedMs, FRAMEWORK, body);
    // Set over the response, the new one would get the old one's headers back (its Content-Length among them).
    c.res = undefined;
    c.res = answer.response;
  };
}
