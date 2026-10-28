// The route's handler as a span of its own, for frameworks no OpenTelemetry instrumentation of ours traces (Fastify,
// Koa, Hono): the processor draws it as Express's route handler, the request's handler named by its route
// (`/books/:id`), with what it runs under it. An error it throws is the request's, unless the framework answers it
// below 500 (a 404 the app threw): that is an answer.

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

/** What tells the processor a span is a route's handler. */
export const VIEW = "view";

const tracer = trace.getTracer("tracepanel-view");

// The errors recorded on a handler's span already: the framework's error hook leaves them be.
const recorded = new WeakSet<object>();

/** The status a framework answers an error with: its own statusCode or status (http-errors, Hono's), else 500. */
export function statusOf(error: unknown): number {
  if (error === null || typeof error !== "object") return 500;
  const { statusCode, status } = error as { statusCode?: unknown; status?: unknown };
  const code = typeof statusCode === "number" ? statusCode : typeof status === "number" ? status : 500;
  return code >= 400 && code < 600 ? code : 500;
}

/**
 * An error the request ends with, on a span: once, and only when the framework answers it with 500 or above.
 * `status`: what it answered, where the app's error handler decides (Hono's onError).
 */
export function recordError(span: Span, error: unknown, status = statusOf(error)): void {
  if (status < 500) return;
  const thrown = error instanceof Error ? error : new Error(String(error));
  if (recorded.has(thrown)) return;
  recorded.add(thrown);
  span.recordException(thrown);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** Whether a handler's span recorded this error already. */
export function wasRecorded(error: unknown): boolean {
  return error !== null && typeof error === "object" && recorded.has(error);
}

/**
 * `run` in a span for the route's handler, named by its route. `origin`: the app's line that added the route, when
 * it is known. An error `run` throws is recorded and thrown on.
 */
export function inView<T>(route: string, origin: string | null, run: (span: Span) => T): T {
  const attributes = {
    "tracepanel.span_kind": VIEW,
    "code.view": route,
    ...(origin ? { "code.origin": origin } : {}),
  };
  return tracer.startActiveSpan(`handler - ${route}`, { attributes }, (span) => {
    let result: T;
    try {
      result = run(span);
    } catch (error) {
      recordError(span, error);
      span.end();
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          span.end();
          return value;
        },
        (error: unknown) => {
          recordError(span, error);
          span.end();
          throw error;
        },
      ) as T;
    }
    span.end();
    return result;
  });
}
