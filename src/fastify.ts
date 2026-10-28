// `await app.register(tracepanel())`, before the routes: a Fastify plugin. Each route's handler is a span of its own,
// named by its route (`/books/:id`) and the app's line that added it; the request's trace is named by the route too.
// Every response gets what the badge reads (Tracepanel-Id, Server-Timing), and an HTML page the widget's script: one
// sent whole has it put into its body, a stream as it passes. What the request carried goes into its trace as the
// response goes out: its headers, query, cookies, the body Fastify parsed, the session (`request.session`), and the
// response's headers. An error the handler throws is the request's unless Fastify answers it below 500.
//
// Fastify's own OpenTelemetry instrumentation is deprecated, and @fastify/otel is a plugin to register too, with a span
// for every hook: this plugin needs nothing but Fastify's hooks.

import type { Readable } from "node:stream";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
  RouteOptions,
} from "fastify";
import type { Attrs } from "./model.js";
import { hasBody, parsedBody, requestAttrs, responseHeaders, searchOf } from "./request.js";
import { runtime } from "./runtime.js";
import { expressSession } from "./session.js";
import { madeAt } from "./stack.js";
import { inView, statusOf, wasRecorded } from "./view.js";
import { inject, responseMarks, streamablePage, streamWith } from "./widget.js";

const TRACED = Symbol.for("tracepanel.fastify.handler");
const FRAMEWORK = "Fastify";

type Handler = RouteHandlerMethod & { [TRACED]?: true };

function isStream(payload: unknown): payload is Readable {
  return payload !== null && typeof payload === "object" && typeof (payload as Readable).pipe === "function";
}

/** What the request carried, the body Fastify parsed, the session as the handler left it, the response's headers. */
function carried(request: FastifyRequest, reply: FastifyReply): Attrs {
  const { headers } = request;
  const body = hasBody(headers) ? parsedBody({ contentType: headers["content-type"] ?? "", body: request.body }) : {};
  return {
    ...requestAttrs(headers, searchOf(request.url)),
    ...body,
    ...expressSession((request as FastifyRequest & { session?: unknown }).session),
    ...responseHeaders(Object.entries(reply.getHeaders())),
  };
}

export function tracepanel(): FastifyPluginAsync {
  const plugin = async (app: FastifyInstance) => {
    const tp = runtime();
    if (!tp) return;
    const started = new WeakMap<FastifyRequest, number>();

    app.addHook("onRoute", (route: RouteOptions) => {
      const handler = route.handler as Handler;
      if (handler[TRACED]) return;
      // The app's line that added the route: where its handler is, most often.
      const origin = madeAt(tp.config.root).origin;
      const name = route.url;
      const traced: Handler = function (this: FastifyInstance, request, reply) {
        return inView(name, origin, () => handler.call(this, request, reply));
      };
      traced[TRACED] = true;
      route.handler = traced;
    });

    app.addHook("onRequest", async (request) => {
      started.set(request, performance.now());
      tp.processor.setFramework(FRAMEWORK);
      const route = request.routeOptions.url;
      if (route) tp.processor.setRoute(route);
    });

    // One a hook threw, or one the handler's span didn't see (a validation error is below 500, and not one).
    app.addHook("onError", async (_request, _reply, error) => {
      if (statusOf(error) >= 500 && !wasRecorded(error)) tp.processor.addError(error);
    });

    app.addHook("onSend", async (request, reply, payload) => {
      if (tp.config.captureRequest) tp.processor.setTraceAttrs(carried(request, reply));
      const header = (name: string) => reply.getHeader(name);
      const html = String(header("content-type") ?? "").includes("text/html") && header("content-encoding") == null;
      const whole = typeof payload === "string" || Buffer.isBuffer(payload);
      const page = html && (whole || (isStream(payload) && streamablePage(header)));
      const marks = responseMarks(
        tp,
        {
          method: request.method,
          status: reply.statusCode,
          startedMs: started.get(request) ?? performance.now(),
          page,
          framework: tp.processor.framework() ?? FRAMEWORK,
        },
        request.headers,
        header,
      );
      if (!marks) return payload;
      reply.headers(marks.headers);
      // Fastify keeps each Set-Cookie it is given.
      if (marks.cookie) reply.header("set-cookie", marks.cookie);
      if (!page || !marks.script) return payload;
      if (isStream(payload)) return streamWith(payload, marks.script);
      const body = inject(Buffer.isBuffer(payload) ? payload.toString("utf8") : (payload as string), marks.script);
      if (header("content-length") !== undefined) reply.header("content-length", Buffer.byteLength(body));
      return body;
    });
  };
  // Not encapsulated, as fastify-plugin would leave it: its hooks are the app's, for the routes added after it.
  Object.assign(plugin, {
    [Symbol.for("skip-override")]: true,
    [Symbol.for("fastify.display-name")]: "tracepanel",
  });
  return plugin;
}
