// Tracepanel in the browser: traces of kind page, each a view or an action on it. A view is the page's load or an SPA's
// route change, named by its path ("/books"); an action is what the user did that called the API or threw, named
// after it on its page ("/books › click "Save""), and "background" when nobody did anything (a timer, polling). Each
// has its fetch() and XMLHttpRequest calls, the errors the page throws and its console, and lasts until its last call
// answered (a view: until the page's load too). Calls to the page's own origin (and to `propagateTo`'s) carry a W3C
// traceparent, so the agent links each to the backend's trace of it. While the panel's Profile is on (its
// tracepanel_profile cookie, on the page's origin), those calls carry X-Tracepanel-Profile with the cookie's value
// too ("1", or "memory"): a backend on another origin never gets the cookie, and is profiled all the same, and so is
// each app it calls in turn. The traces go to the console's address (`api`), which the dev server serves on the
// page's origin.
//
//   import { record } from "@tracepanel/js/browser";
//   record({ api: "/__tracepanel__/", service: "shop-web" });
//
// @tracepanel/js/vite's plugin and Next.js's `<Tracepanel />` load it by themselves. Nothing here runs outside a
// browser, and nothing imports Node.
//
// The page's widget shows them too: each view and action is announced on window ("tracepanel:page") when it starts
// and when it ends, and each response carries the id of the one that made it (Symbol.for("tracepanel.page") on the
// Response or the XMLHttpRequest), so the panel lists a page's requests under what the user did.

export interface BrowserOptions {
  /** Where the console is, on the page's origin: "/__tracepanel__/". */
  api?: string;
  /** The app's name in the console. "browser" by default. */
  service?: string;
  /**
   * Other origins whose calls carry a traceparent, and X-Tracepanel-Profile while the panel's Profile is on: their
   * CORS must allow both headers (`cors()` and `allow_headers=["*"]` do).
   */
  propagateTo?: string[];
  /**
   * Scripts whose console isn't the page's, by a part of their path: a dev server's own client ("/@vite/").
   * @tracepanel/js/vite and Next.js's `<Tracepanel />` set their own; a library's warnings still count (React's).
   */
  ignoreSources?: string[];
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
  /** Its calls not answered yet: closed as unfinished if it goes out before they answer. */
  open: Set<Span>;
  /** Sent: a call that answers after it changes nothing. */
  sent: boolean;
  lastActivityMs: number;
  /** When the last call answered or the last error was thrown: where the trace ends. */
  endUs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type Trigger = "load" | "navigation" | "click" | "submit" | "background";

/** A view or an action as the widget lists it: announced when it starts (open) and again when it ends. */
export interface PageAnnouncement {
  id: string;
  name: string;
  /** Microseconds since the epoch. */
  start: number;
  /** Microseconds; 0 while open. */
  duration: number;
  status: "ok" | "error";
  open: boolean;
}

function announce(trace: View["trace"], open: boolean): void {
  const detail: PageAnnouncement = {
    id: trace.id,
    name: trace.name,
    start: trace.start,
    duration: trace.duration,
    status: trace.status,
    open,
  };
  const scope = globalThis as unknown as Record<symbol, Map<string, PageAnnouncement> | undefined>;
  const seen = scope[ANNOUNCED] ?? new Map<string, PageAnnouncement>();
  scope[ANNOUNCED] = seen;
  seen.delete(detail.id);
  seen.set(detail.id, detail);
  if (seen.size > ANNOUNCED_MAX) seen.delete(seen.keys().next().value as string);
  window.dispatchEvent(new CustomEvent("tracepanel:page", { detail }));
}

/** What the user just did: the action the calls it makes belong to. */
interface Interaction {
  trigger: "click" | "submit";
  label: string;
  /** performance.now() of the event. */
  atMs: number;
}

// A view is done once nothing happened for this long, or after the longest.
const QUIET_MS = 1000;
const LONGEST_MS = 15_000;
const MAX_SPANS = 500;
// On a Response or an XMLHttpRequest: the view or action that made the call.
const PAGE = Symbol.for("tracepanel.page");
// On globalThis: the latest views and actions announced, for a widget that starts listening after them.
const ANNOUNCED = Symbol.for("tracepanel.pages");
const ANNOUNCED_MAX = 50;
// Calls this soon after a click or a submit are its action's; later ones are background.
const INTERACTION_MS = 1000;
const LABEL_LENGTH = 40;
// What a click names its action after: the control it hit, not the text node or the icon inside it.
const CONTROL =
  "[data-tracepanel-name],button,a,[role=button],[role=link],[role=menuitem],[role=tab],input[type=submit]," +
  "input[type=button],input[type=checkbox],input[type=radio],select,summary,label";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SECRET = /(token|key|secret|password|passwd|pwd|auth|signature|sig|session|credential)/i;
// The panel's Profile toggle: its cookie on the page's origin, and the header a call asks a backend with.
const PROFILE_COOKIE = "tracepanel_profile";
const PROFILE_HEADER = "X-Tracepanel-Profile";

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

/** A performance.now() reading, in microseconds since the epoch. */
function toUs(ms: number): number {
  return Math.round((performance.timeOrigin + ms) * 1000);
}

/** When the page's load event ended, in microseconds since the epoch: now while it hasn't. */
function loadEndUs(): number {
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.loadEventEnd ? toUs(entry.loadEventEnd) : nowUs();
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

/** What the panel's Profile toggle asks for now: "1", "memory", or nothing while it is off. */
function profileAsked(): string | undefined {
  let cookies = "";
  try {
    cookies = document.cookie;
  } catch {
    // A sandboxed page has no cookies.
  }
  for (const pair of cookies.split(";")) {
    const [name, value] = pair.trim().split("=", 2);
    if (name === PROFILE_COOKIE) return value === "1" || value === "memory" ? value : undefined;
  }
  return undefined;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_LENGTH ? `${flat.slice(0, LABEL_LENGTH - 1)}…` : flat;
}

/**
 * A control's name, as the user sees it: data-tracepanel-name, its aria-label, its text, else its id or tag. Never a
 * text field's value: only the caption of a button input.
 */
function controlName(element: Element): string {
  const input = element instanceof HTMLInputElement && ["submit", "button"].includes(element.type) ? element.value : "";
  const text = element instanceof HTMLElement && !(element instanceof HTMLSelectElement) ? element.innerText : "";
  const name =
    element.getAttribute("data-tracepanel-name") ||
    element.getAttribute("aria-label") ||
    clip(text ?? "") ||
    input ||
    element.getAttribute("title") ||
    (element.id ? `#${element.id}` : "");
  return name ? `"${clip(name)}"` : element.tagName.toLowerCase();
}

/** A form's name: data-tracepanel-name, its aria-label, name or id, else where it posts. */
function formName(form: HTMLFormElement): string {
  const name =
    form.getAttribute("data-tracepanel-name") ||
    form.getAttribute("aria-label") ||
    form.getAttribute("name") ||
    (form.id ? `#${form.id}` : "");
  if (name) return `"${clip(name)}"`;
  const action = safeUrl(form.getAttribute("action") ?? "");
  return action ? action.pathname : "form";
}

/**
 * Where a console call came from: the first frame of the stack that isn't this script's own, nor another wrapper of
 * console's methods (Next.js's dev overlay wraps them after the recording did: its frame reads `console.log`).
 */
function caller(stack: string | undefined, own: string | undefined): Frame | undefined {
  return frames(stack)
    .reverse()
    .find((frame) => frame.filename !== own && !/^console\./i.test(frame.function));
}

/** Where a console call was made, as the other SDKs say it: the file and line, and the function when it has a name. */
function whereLogged(frame: Frame): Attrs {
  const named = frame.function !== "<anonymous>" ? { "code.function": frame.function } : {};
  return { "code.filepath": frame.filename, "code.lineno": frame.lineno, ...named };
}

/** A browser stack's frames, oldest first: the page's own scripts are the app's. */
/** A stack frame as the agent stores an error's. */
interface Frame {
  filename: string;
  module: string;
  function: string;
  lineno: number;
  in_app: boolean;
  context_start: null;
  context: string[];
  locals: Attrs;
}

function frames(stack: string | undefined): Frame[] {
  const found: Frame[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line) ?? /^(.*?)@(.+?):(\d+):\d+$/.exec(line);
    if (!match) continue;
    // A script's URL; code with no file of its own (eval, a console) is named as the browser names it: <anonymous>.
    const raw = match[2] ?? "";
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? safeUrl(raw) : undefined;
    found.push({
      filename: url ? url.pathname : raw,
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
  const ignored = options.ignoreSources ?? [];
  // This script's own path, to tell a console call's caller from the wrapper it went through.
  const own = frames(new Error().stack).at(-1)?.filename;
  let view: View | undefined;
  let interaction: Interaction | undefined;

  /** A view (no action: the page's load, a route change) or an action on the page, from `startUs`. */
  function start(trigger: Trigger, action?: string, startUs = nowUs()): View {
    const path = location.pathname;
    const name = action ? `${path} › ${action}` : path;
    const root: Span = {
      id: newId(),
      parent_id: null,
      kind: "page",
      name,
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
        name,
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
          ...(action ? { "page.action": action } : {}),
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
      open: new Set(),
      sent: false,
      lastActivityMs: performance.now(),
      endUs: startUs,
      timer: undefined,
    };
    view = started;
    settleLater(started);
    announce(started.trace, true);
    return started;
  }

  /** The view goes out once quiet: no call open and nothing new for a second, or after the longest wait. */
  function settleLater(current: View): void {
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      const loading = current.trace.attrs["page.trigger"] === "load" && document.readyState !== "complete";
      const quiet = !loading && performance.now() - current.lastActivityMs >= QUIET_MS;
      const old = nowUs() - current.trace.start >= LONGEST_MS * 1000;
      if ((current.pending === 0 && quiet) || old) finish(current);
      else settleLater(current);
    }, QUIET_MS);
  }

  function finish(current: View): void {
    if (view === current) view = undefined;
    if (current.timer) clearTimeout(current.timer);
    if (current.sent) return;
    current.sent = true;
    // A call still open (a route change, the tab going away, the longest wait) goes out as far as it got: no answer
    // yet, so no status code, and marked unfinished.
    const sentUs = nowUs();
    for (const span of current.open) {
      span.duration = sentUs - span.start;
      span.attrs["http.unfinished"] = true;
    }
    current.open.clear();
    // Until its last call answered, not the quiet second after: a view, until the page's load too.
    const lastSpan = Math.max(...current.trace.spans.map((span) => span.start + span.duration));
    let end = Math.max(current.endUs, lastSpan, current.trace.start);
    if (current.trace.attrs["page.trigger"] === "load") end = Math.max(end, loadEndUs());
    current.trace.duration = end - current.trace.start;
    current.root.duration = current.trace.duration;
    // Failed for the user: the page threw, or a call failed (an answer of 5xx, or none).
    if (current.trace.errors.length > 0 || current.trace.spans.some((span) => span.status === "error")) {
      current.trace.status = "error";
    }
    announce(current.trace, false);
    void send(`${api}api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([current.trace]),
      keepalive: true,
    }).catch(() => undefined);
  }

  /**
   * The trace a call or an error belongs to. Right after a click or a submit: its action, and the trace before it
   * goes out unless its calls still run (then they share it). Else the open trace, or background activity.
   */
  function active(): View {
    const done = interaction;
    if (done && performance.now() - done.atMs < INTERACTION_MS) {
      interaction = undefined;
      if (view && view.pending === 0) finish(view);
      if (!view) return start(done.trigger, `${done.trigger} ${done.label}`, toUs(done.atMs));
    }
    return view ?? start("background", "background");
  }

  function touch(current: View): void {
    current.lastActivityMs = performance.now();
    current.endUs = Math.max(current.endUs, nowUs());
    settleLater(current);
  }

  // What the user does: the calls right after belong to its action. Capture: before the app's own handlers.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const control = target.closest(CONTROL) ?? target;
      interaction = { trigger: "click", label: controlName(control), atMs: event.timeStamp || performance.now() };
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      interaction = { trigger: "submit", label: formName(event.target), atMs: event.timeStamp || performance.now() };
    },
    true,
  );

  /** A call out of the page, as the other SDKs record theirs: http.client, its W3C span id for the backend's link. */
  function call(
    method: string,
    raw: string,
  ): {
    /** Answered with `status`, or failed with no answer: `failure` names why (TypeError, AbortError, timeout). */
    finish(status: number, failure?: string): void;
    traceparent?: string | undefined;
    profile?: string | undefined;
    page?: string;
  } {
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
    current.open.add(span);
    const propagated = propagate.has(url.origin);
    return {
      traceparent: propagated ? `00-${current.w3cTraceId}-${spanId}-01` : undefined,
      // Where a traceparent goes, the panel's Profile asks for a profile too.
      profile: propagated ? profileAsked() : undefined,
      page: current.trace.id,
      finish(status, failure) {
        current.pending -= 1;
        // Its trace went out without it: closed there as unfinished.
        if (!current.open.delete(span)) return;
        span.duration = nowUs() - span.start;
        current.endUs = Math.max(current.endUs, span.start + span.duration);
        // No answer (the network, CORS, an abort): no status code, why it failed instead, as OpenTelemetry has it.
        if (failure !== undefined) span.attrs["error.type"] = failure;
        else span.attrs["http.response.status_code"] = status;
        if (failure !== undefined || status >= 500) span.status = "error";
        touch(current);
      },
    };
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const out = call(request.method, request.url);
    const headers = new Headers(request.headers);
    if (out.traceparent && !headers.has("traceparent")) headers.set("traceparent", out.traceparent);
    if (out.profile && !headers.has(PROFILE_HEADER)) headers.set(PROFILE_HEADER, out.profile);
    try {
      // Marked as it arrives, before anything else runs: a wrapper of fetch around this one (the widget's) reads the
      // mark as soon as the Response reaches it.
      const response = await send(new Request(request, { headers })).then((arrived) => {
        if (out.page) Object.defineProperty(arrived, PAGE, { value: out.page });
        return arrived;
      });
      out.finish(response.status);
      return response;
    } catch (error) {
      out.finish(0, (error instanceof Error && error.name) || "Error");
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
      if (out.profile) this.setRequestHeader(PROFILE_HEADER, out.profile);
      if (out.page) Object.defineProperty(this, PAGE, { value: out.page, configurable: true });
      // No answer: why, from the event before loadend (a network error, an abort, the request's timeout).
      let failure = "Error";
      this.addEventListener("error", () => (failure = "NetworkError"));
      this.addEventListener("abort", () => (failure = "AbortError"));
      this.addEventListener("timeout", () => (failure = "timeout"));
      this.addEventListener("loadend", () => out.finish(this.status, this.status === 0 ? failure : undefined));
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
      const from = current ? caller(new Error().stack, own) : undefined;
      const source = from?.filename ?? "";
      if (current && !ignored.some((part) => source.includes(part))) {
        current.trace.logs.push({
          span_id: null,
          time: nowUs(),
          level,
          logger: "console",
          message: args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
          exception: args.find((arg): arg is Error => arg instanceof Error)?.stack ?? null,
          attrs: from ? whereLogged(from) : {},
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
        interaction = undefined;
        start("navigation");
      }
      return result;
    };
  }
  window.addEventListener("popstate", () => {
    if (view) finish(view);
    interaction = undefined;
    start("navigation");
  });
  // The tab going away: what is open goes out now.
  window.addEventListener("pagehide", () => {
    if (view) finish(view);
  });

  // The first view started when the browser began loading the page.
  start("load", undefined, Math.round(performance.timeOrigin * 1000));
}
