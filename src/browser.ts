// Tracepanel in the browser: each page view, and each burst of activity after it (a click that calls the API, a route
// change in an SPA), is a trace of kind page: its fetch() and XMLHttpRequest calls, the errors the page throws and
// its console. Calls to the page's own origin carry a W3C traceparent, so the agent links each to the backend's trace
// of it. The traces go to the console's address (`api`), which the dev server serves on the page's origin.
//
//   import { record } from "tracepanel/browser";
//   record({ api: "/__tracepanel__/", service: "shop-web" });
//
// tracepanel/vite's plugin loads it by itself. Nothing here runs outside a browser, and nothing imports Node.

export interface BrowserOptions {
  /** Where the console is, on the page's origin: "/__tracepanel__/". */
  api?: string;
  /** The app's name in the console. "browser" by default. */
  service?: string;
  /** Other origins whose calls carry a traceparent (their CORS must allow the header). */
  propagateTo?: string[];
}

type Attrs = Record<string, unknown>;

interface Span {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  start: number;
  duration: number;
  status: "ok" | "error";
  attrs: Attrs;
}

interface View {
  trace: {
    id: string;
    kind: "page";
    name: string;
    start: number;
    duration: number;
    status: "ok" | "error";
    attrs: Attrs;
    spans: Span[];
    logs: Attrs[];
    errors: Attrs[];
    links: unknown[];
    issues: unknown[];
  };
  root: Span;
  w3cTraceId: string;
  pending: number;
  lastActivityMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// A view is done once nothing happened for this long, or after the longest.
const QUIET_MS = 1000;
const LONGEST_MS = 15_000;
const MAX_SPANS = 500;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SECRET = /(token|key|secret|password|passwd|pwd|auth|signature|sig|session|credential)/i;

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A ULID, as the other SDKs make the ids: 48 bits of milliseconds, 80 random bits. */
function newId(): string {
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${hex(10)}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** Now, in microseconds since the epoch, as the agent stores times. */
function nowUs(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

function safeUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw, location.href);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET.test(name)) url.searchParams.set(name, "***");
    }
    return url;
  } catch {
    return undefined;
  }
}

/** A browser stack's frames, oldest first: the page's own scripts are the app's. */
function frames(stack: string | undefined): Attrs[] {
  const found: Attrs[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line) ?? /^(.*?)@(.+?):(\d+):\d+$/.exec(line);
    if (!match) continue;
    const url = safeUrl(match[2] ?? "");
    found.push({
      filename: url ? url.pathname : (match[2] ?? ""),
      module: "",
      function: match[1] || "<anonymous>",
      lineno: Number(match[3]),
      in_app: url?.origin === location.origin && !url.pathname.includes("/node_modules/"),
      context_start: null,
      context: [],
      locals: {},
    });
  }
  return found.reverse();
}

export function record(options: BrowserOptions = {}): void {
  const scope = globalThis as { __tracepanelRecording?: boolean };
  if (typeof window === "undefined" || scope.__tracepanelRecording) return;
  scope.__tracepanelRecording = true;
  const api = new URL(options.api ?? "/__tracepanel__/", location.href).toString();
  const propagate = new Set([location.origin, ...(options.propagateTo ?? [])]);
  const send = window.fetch.bind(window);
  let view: View | undefined;

  function start(trigger: "load" | "navigation" | "activity", startUs = nowUs()): View {
    const path = location.pathname;
    const root: Span = {
      id: newId(),
      parent_id: null,
      kind: "page",
      name: path,
      start: startUs,
      duration: 0,
      status: "ok",
      attrs: {},
    };
    const w3cTraceId = hex(16);
    const started: View = {
      trace: {
        id: newId(),
        kind: "page",
        name: path,
        start: startUs,
        duration: 0,
        status: "ok",
        attrs: {
          "service.name": options.service ?? "browser",
          "service.role": "browser",
          "telemetry.sdk.language": "webjs",
          "page.path": path,
          "page.url": `${location.origin}${path}`,
          "page.title": document.title,
          "page.trigger": trigger,
          "user_agent.original": navigator.userAgent,
          "w3c.trace_id": w3cTraceId,
        },
        spans: [root],
        logs: [],
        errors: [],
        links: [],
        issues: [],
      },
      root,
      w3cTraceId,
      pending: 0,
      lastActivityMs: performance.now(),
      timer: undefined,
    };
    view = started;
    settleLater(started);
    return started;
  }

  /** The view goes out once quiet: no call open and nothing new for a second, or after the longest wait. */
  function settleLater(current: View): void {
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      const quiet = performance.now() - current.lastActivityMs >= QUIET_MS;
      const old = nowUs() - current.trace.start >= LONGEST_MS * 1000;
      if ((current.pending === 0 && quiet) || old) finish(current);
      else settleLater(current);
    }, QUIET_MS);
  }

  function finish(current: View): void {
    if (view === current) view = undefined;
    if (current.timer) clearTimeout(current.timer);
    const end = Math.max(nowUs() - QUIET_MS * 1000, current.trace.start);
    const lastSpan = Math.max(...current.trace.spans.map((span) => span.start + span.duration));
    current.trace.duration = Math.max(end, lastSpan) - current.trace.start;
    current.root.duration = current.trace.duration;
    if (current.trace.errors.length > 0) current.trace.status = "error";
    void send(`${api}api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([current.trace]),
      keepalive: true,
    }).catch(() => undefined);
  }

  /** The view a call or an error belongs to: the open one, or a new one for activity after the last. */
  function active(): View {
    return view ?? start("activity");
  }

  function touch(current: View): void {
    current.lastActivityMs = performance.now();
    settleLater(current);
  }

  /** A call out of the page, as the other SDKs record theirs: http.client, its W3C span id for the backend's link. */
  function call(
    method: string,
    raw: string,
  ): { finish(status: number, failed: boolean): void; traceparent?: string | undefined } {
    const url = safeUrl(raw);
    if (!url || url.toString().startsWith(api)) return { finish: () => undefined };
    const current = active();
    current.pending += 1;
    const spanId = hex(8);
    const span: Span = {
      id: newId(),
      parent_id: current.root.id,
      kind: "http.client",
      name: `${method.toUpperCase()} ${url.host}${url.pathname}`,
      start: nowUs(),
      duration: 0,
      status: "ok",
      attrs: {
        "http.request.method": method.toUpperCase(),
        "url.full": url.toString(),
        "url.scheme": url.protocol.replace(":", ""),
        "server.address": url.hostname,
        "server.port": Number(url.port) || (url.protocol === "https:" ? 443 : 80),
        "w3c.span_id": spanId,
      },
    };
    if (current.trace.spans.length < MAX_SPANS) current.trace.spans.push(span);
    return {
      traceparent: propagate.has(url.origin) ? `00-${current.w3cTraceId}-${spanId}-01` : undefined,
      finish(status, failed) {
        span.duration = nowUs() - span.start;
        span.attrs["http.response.status_code"] = status;
        if (failed || status >= 500) span.status = "error";
        current.pending -= 1;
        touch(current);
      },
    };
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const out = call(request.method, request.url);
    const headers = new Headers(request.headers);
    if (out.traceparent && !headers.has("traceparent")) headers.set("traceparent", out.traceparent);
    try {
      const response = await send(new Request(request, { headers }));
      out.finish(response.status, false);
      return response;
    } catch (error) {
      out.finish(0, true);
      throw error;
    }
  };

  const open = XMLHttpRequest.prototype.open;
  const sendXhr = XMLHttpRequest.prototype.send;
  const calls = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    calls.set(this, { method, url: String(url) });
    return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const target = calls.get(this);
    if (target) {
      const out = call(target.method, target.url);
      if (out.traceparent) this.setRequestHeader("traceparent", out.traceparent);
      this.addEventListener("loadend", () => out.finish(this.status, this.status === 0));
    }
    return sendXhr.call(this, body);
  };

  function error(thrown: unknown): void {
    const current = active();
    const err = thrown instanceof Error ? thrown : new Error(String(thrown));
    current.trace.errors.push({
      span_id: null,
      time: nowUs(),
      type: err.name || "Error",
      message: err.message,
      handled: false,
      frames: frames(err.stack),
      chain: [],
    });
    touch(current);
  }
  window.addEventListener("error", (event) => error(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => error(event.reason));

  const levels: Record<string, string> = { debug: "debug", log: "info", info: "info", warn: "warning", error: "error" };
  for (const [method, level] of Object.entries(levels)) {
    const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[method];
    if (!original) continue;
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const current = view;
      if (current) {
        current.trace.logs.push({
          span_id: null,
          time: nowUs(),
          level,
          logger: "console",
          message: args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
          exception: args.find((arg): arg is Error => arg instanceof Error)?.stack ?? null,
          attrs: {},
        });
      }
      original.apply(console, args);
    };
  }

  // An SPA's route change starts a view of the new page.
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const before = location.pathname;
      const result = original.apply(this, args);
      if (location.pathname !== before) {
        if (view) finish(view);
        start("navigation");
      }
      return result;
    };
  }
  window.addEventListener("popstate", () => {
    if (view) finish(view);
    start("navigation");
  });
  // The tab going away: what is open goes out now.
  window.addEventListener("pagehide", () => {
    if (view) finish(view);
  });

  // The first view started when the browser began loading the page.
  start("load", Math.round(performance.timeOrigin * 1000));
}
