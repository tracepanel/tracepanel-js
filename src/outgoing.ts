// Outgoing HTTP on Bun. Node's instrumentations see fetch() through undici's diagnostics channel and node:http by
// patching the module as it loads; Bun's fetch has no such channel and its node:http is built in. Here both make the
// same http.client span as on Node, and send its W3C traceparent, so the callee's trace links to it.

import type { request as httpRequest, IncomingMessage, RequestOptions } from "node:http";
import { createRequire } from "node:module";
import { type Attributes, context, propagation, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("tracepanel-outgoing");
const WRAPPED = Symbol.for("tracepanel.outgoing");

function attributes(method: string, url: URL): Attributes {
  return {
    "http.request.method": method,
    "url.full": url.href,
    "url.scheme": url.protocol.replace(":", ""),
    "server.address": url.hostname,
    "server.port": url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
  };
}

function marked<F>(wrapped: F): F {
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped;
}

function failed(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

type Fetch = typeof globalThis.fetch;

/** fetch(), each call an http.client span with the traceparent in its headers. */
export function tracedFetch(fetch: Fetch): Fetch {
  if ((fetch as { [WRAPPED]?: boolean })[WRAPPED]) return fetch;
  const traced = async function (this: unknown, input: string | URL | Request, init?: RequestInit) {
    if (!trace.getActiveSpan()) return fetch.call(this, input, init);
    const request = input instanceof Request ? input : undefined;
    let url: URL;
    try {
      url = new URL(request ? request.url : String(input));
    } catch {
      return fetch.call(this, input, init);
    }
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const span = tracer.startSpan(method, { kind: SpanKind.CLIENT, attributes: attributes(method, url) });
    const inside = trace.setSpan(context.active(), span);
    const headers = new Headers(init?.headers ?? request?.headers);
    propagation.inject(inside, headers, { set: (carrier, key, value) => carrier.set(key, value) });
    try {
      const response = await context.with(inside, () => fetch.call(this, input, { ...init, headers }));
      span.setAttribute("http.response.status_code", response.status);
      if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    } catch (error) {
      failed(span, error);
      throw error;
    } finally {
      span.end();
    }
  };
  return marked(Object.assign(traced, fetch) as Fetch);
}

type HttpRequest = typeof httpRequest;

/** Where a node:http request goes: request(url, options?, callback?) or request(options, callback?). */
function target(args: unknown[], scheme: "http" | "https"): { method: string; url: URL } | undefined {
  try {
    const [first, second] = args;
    const given = typeof first === "string" || first instanceof URL ? new URL(first) : undefined;
    const options = (given ? (typeof second === "object" && second ? second : {}) : (first ?? {})) as RequestOptions;
    const method = String(options.method ?? "GET").toUpperCase();
    if (given) return { method, url: given };
    const host = options.hostname ?? options.host ?? "localhost";
    const port = options.port ? `:${options.port}` : "";
    const protocol = options.protocol ?? `${scheme}:`;
    return { method, url: new URL(`${protocol}//${host}${port}${options.path ?? "/"}`) };
  } catch {
    return undefined;
  }
}

/** node:http's (or https's) request(): each call an http.client span, its traceparent a header of the request. */
export function tracedRequest(request: HttpRequest, scheme: "http" | "https"): HttpRequest {
  if ((request as { [WRAPPED]?: boolean })[WRAPPED]) return request;
  const send = request as (...args: unknown[]) => ReturnType<HttpRequest>;
  const traced = function (this: unknown, ...args: unknown[]) {
    const found = trace.getActiveSpan() ? target(args, scheme) : undefined;
    if (!found) return send.apply(this, args);
    const span = tracer.startSpan(found.method, {
      kind: SpanKind.CLIENT,
      attributes: attributes(found.method, found.url),
    });
    const inside = trace.setSpan(context.active(), span);
    const sent = context.with(inside, () => send.apply(this, args));
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      span.end();
    };
    try {
      propagation.inject(inside, sent, { set: (carrier, key, value) => carrier.setHeader(key, value) });
    } catch {
      // The headers went out already: the call is recorded all the same.
    }
    sent.once("response", (response: IncomingMessage) => {
      span.setAttribute("http.response.status_code", response.statusCode ?? 0);
      if ((response.statusCode ?? 0) >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      response.once("end", end);
      response.once("close", end);
    });
    sent.once("error", (error) => {
      failed(span, error);
      end();
    });
    sent.once("close", end);
    return sent;
  };
  return marked(traced as HttpRequest);
}

/** get(): request() that ends the request itself, as node:http's does. */
function tracedGet(request: HttpRequest): HttpRequest {
  const send = request as (...args: unknown[]) => ReturnType<HttpRequest>;
  return marked(function (this: unknown, ...args: unknown[]) {
    const sent = send.apply(this, args);
    sent.end();
    return sent;
  } as HttpRequest);
}

/** Bun's fetch and node:http/https, traced: what the undici and http instrumentations do on Node. */
export function traceBunCalls(): void {
  globalThis.fetch = tracedFetch(globalThis.fetch);
  const require = createRequire(import.meta.url);
  for (const scheme of ["http", "https"] as const) {
    const target = require(`node:${scheme}`) as { request: HttpRequest; get: HttpRequest };
    if ((target.request as { [WRAPPED]?: boolean })[WRAPPED]) continue;
    target.request = tracedRequest(target.request, scheme);
    target.get = tracedGet(target.request);
  }
}
