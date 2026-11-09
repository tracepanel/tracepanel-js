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
//
// A framework tells the recording what it knows and the page doesn't say: `route()` names the page by its route
// ("/books/:id") once its router matched one, and `report()` gives it an error the framework caught before it reached
// window (Angular's ErrorHandler). @tracepanel/js/angular calls both.

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
// On globalThis: what route() and report() reach the recording by, whichever copy of this file started it (the one
// the Vite plugin serves, the app's own bundle's).
const RECORDING = Symbol.for("tracepanel.recording");

interface Recording {
  report(error: unknown): void;
  route(template: string, title?: string): void;
}

function recording(): Recording | undefined {
  return (globalThis as Record<symbol, Recording | undefined>)[RECORDING];
}

/**
 * An error the app's framework caught before it reached window (Angular's ErrorHandler): it fails the view or the
 * action it happened in, as an uncaught one does. One that reaches window too counts once. Nothing while the page
 * isn't recorded.
 */
export function report(error: unknown): void {
  recording()?.report(error);
}

/**
 * The page's route as its router matched it, such as "/books/:id", and its title: the page's view, and what users do
 * on it, are named by the route instead of the path ("/books/2"), so the console groups every book's page as one.
 * Called once the route is matched; the page's path stays in `page.path`. Nothing while the page isn't recorded.
 */
export function route(template: string, title?: string): void {
  recording()?.route(template, title);
}

// Calls this soon after a click or a submit are its action's; later ones are background.
const INTERACTION_MS = 1000;
const LABEL_LENGTH = 40;
// What a click names its action after: the control it hit, not the text node or the icon inside it.
const CONTROL =
  "[data-tracepanel-name],button,a,[role=button],[role=link],[role=menuitem],[role=tab],input[type=submit]," +
  "input[type=button],input[type=checkbox],input[type=radio],select,summary,label";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// A query parameter that holds a secret, word by word as masking.ts reads a name (this file is served alone, so it
// carries its own copy): a secret's whole word (`token`, `auth`, not `author`), words written together
// (`accesstoken`, `sessionid`), `api key`, and a URL's own `key`, `sig`, `pwd`, `credential`.
const WORD_BREAKS = /[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const SECRET_WORDS = new Set(
  (
    "pass passwd password passwords passphrase passcode passkey secret secrets secretkey token tokens apikey apikeys " +
    "auth oauth oauth2 authorization authentication cookie cookies session sessions csrf xsrf signature signatures " +
    "private key sig pwd credential credentials"
  ).split(" "),
);
const SECRET_ENDS = ["token", "secret", "password", "passwd", "apikey", "sessionid", "sessid"];
const SECRET_STARTS = ["password", "apikey", "csrf", "xsrf", "session", "cookie"];
const MASK = "********";

function secretParameter(name: string): boolean {
  const words = name
    .split(WORD_BREAKS)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
  return words.some(
    (word) =>
      SECRET_WORDS.has(word) ||
      SECRET_ENDS.some((end) => word.endsWith(end)) ||
      SECRET_STARTS.some((start) => word.startsWith(start)),
  );
}
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

/**
 * The page's own document as a call of its load, from the browser's navigation timing: the request went before any
 * script ran, so no traceparent linked it; the page names the trace that served it (the widget's tag, as every
 * server SDK writes it). None where the page names none: a dev server's static page served no trace.
 */
function documentCall(root: Span): Span | undefined {
  const tag = document.querySelector("script[data-tracepanel-id]");
  const served = tag?.getAttribute("data-tracepanel-id");
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const url = safeUrl(entry?.name || location.href);
  if (!served || !entry?.responseEnd || !url) return undefined;
  const from = entry.requestStart || entry.startTime;
  const method = (tag?.getAttribute("data-tracepanel-method") ?? "GET").toUpperCase();
  const status = entry.responseStatus || Number(tag?.getAttribute("data-tracepanel-status")) || undefined;
  return {
    id: newId(),
    parent_id: root.id,
    kind: "http.client",
    name: `${method} ${url.host}${url.pathname}`,
    start: toUs(from),
    duration: Math.max(0, Math.round((entry.responseEnd - from) * 1000)),
    status: status !== undefined && status >= 500 ? "error" : "ok",
    attrs: {
      "http.request.method": method,
      "url.full": url.toString(),
      "url.scheme": url.protocol.replace(":", ""),
      "server.address": url.hostname,
      "server.port": Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      ...(status === undefined ? {} : { "http.response.status_code": status }),
      "tracepanel.served_by": served,
    },
  };
}

function safeUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw, location.href);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) {
      if (secretParameter(name)) url.searchParams.set(name, MASK);
    }
    return url;
  } catch {
    return undefined;
  }
}

// A GraphQL request's operation, from what it sends: `{"query": …, "operationName": …}` as JSON (POST), the document
// itself (application/graphql), or the `query` and `operationName` parameters (GET). Its type is the document's first
// operation's, its name the one the client sent, else that operation's own; an anonymous one has none. The agent and
// its widget read a body by the same rule. The server SDK reads a request's by this one too: browser.js imports
// nothing, so it lives here.

const OPERATION = /^\s*(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/;

/** The largest body read for its operation, in characters. */
export const GRAPHQL_MAX = 100_000;

/** A GraphQL operation's type and name, as OpenTelemetry's conventions name them. */
export type GraphqlOperation = {
  "graphql.operation.type": string;
  "graphql.operation.name": string;
};

/** A named operation, from its document and the operationName the client sent with it. */
export function graphqlOperation(query: unknown, operationName?: unknown): GraphqlOperation | undefined {
  const match = typeof query === "string" ? OPERATION.exec(query) : null;
  if (!match?.[1] || !match[2]) return undefined;
  const name = typeof operationName === "string" && operationName ? operationName : match[2];
  return { "graphql.operation.type": match[1], "graphql.operation.name": name };
}

/** From a request's body: JSON with a query in it, or a document (`application/graphql`). */
export function graphqlOperationOfBody(body: unknown, contentType = ""): GraphqlOperation | undefined {
  if (typeof body !== "string" || body.length > GRAPHQL_MAX) return undefined;
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/graphql") return graphqlOperation(body);
  if (!body.includes('"query"')) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const { query, operationName } = parsed as { query?: unknown; operationName?: unknown };
    return graphqlOperation(query, operationName);
  } catch {
    return undefined;
  }
}

/** From a GET request's query string (`?query=query+Books…`). */
export function graphqlOperationOfQuery(search: string): GraphqlOperation | undefined {
  if (!search.includes("query=") || search.length > GRAPHQL_MAX) return undefined;
  const params = new URLSearchParams(search);
  return graphqlOperation(params.get("query"), params.get("operationName"));
}

/** The longest document a call's span keeps, in characters, as the server SDK keeps an operation's (graphql.ts). */
const DOCUMENT_MAX = 2_000;

/** A GraphQL document as a span keeps it: its whitespace collapsed, cut at DOCUMENT_MAX. */
function documentText(query: unknown): string | undefined {
  if (typeof query !== "string" || !query.trim()) return undefined;
  const text = query.replace(/\s+/g, " ").trim();
  return text.length <= DOCUMENT_MAX ? text : `${text.slice(0, DOCUMENT_MAX)}…`;
}

/** The document a request's body sent: the JSON's `query`, or the body itself (`application/graphql`). */
function documentOfBody(body: unknown, contentType: string): string | undefined {
  if (typeof body !== "string" || body.length > GRAPHQL_MAX) return undefined;
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/graphql") return documentText(body);
  try {
    return documentText((JSON.parse(body) as { query?: unknown }).query);
  } catch {
    return undefined;
  }
}

/**
 * What a GraphQL call sent, as its span says it: its operation, and its document, so the call's details show what it
 * asked even when the server that answered records no trace of the document (a gateway's spans over OTLP). None for
 * any other call.
 */
export function graphqlCall(
  method: string,
  search: string,
  body: unknown,
  contentType = "",
): (GraphqlOperation & { "graphql.document"?: string }) | undefined {
  const get = method.toUpperCase() === "GET";
  const operation = get ? graphqlOperationOfQuery(search) : graphqlOperationOfBody(body, contentType);
  if (!operation) return undefined;
  const document = get ? documentText(new URLSearchParams(search).get("query")) : documentOfBody(body, contentType);
  return document ? { ...operation, "graphql.document": document } : operation;
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
  // The route the router matched last (route()), for the path it matched it on.
  let routed: { path: string; template: string; title: string | undefined } | undefined;

  /** A view (no action: the page's load, a route change) or an action on the page, from `startUs`. */
  function start(trigger: Trigger, action?: string, startUs = nowUs()): View {
    const path = location.pathname;
    const matched = routed?.path === path ? routed : undefined;
    const page = matched?.template ?? path;
    const name = action ? `${page} › ${action}` : page;
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
          ...(matched ? { "page.route": matched.template } : {}),
          "page.url": `${location.origin}${path}`,
          "page.title": matched?.title ?? document.title,
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
    // The page's load: its own document first among its calls.
    const own = current.trace.attrs["page.trigger"] === "load" ? documentCall(current.root) : undefined;
    if (own) current.trace.spans.splice(1, 0, own);
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
    body?: unknown,
    contentType?: string,
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
        // A GraphQL request's operation and document, whatever its answer (none, an error, a 503 before it ran).
        ...graphqlCall(method, url.search, body, contentType),
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
    // The body as the app passed it: a string is read for a GraphQL operation, a stream never.
    const sent = init?.body ?? undefined;
    const out = call(request.method, request.url, sent, request.headers.get("content-type") ?? undefined);
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
  const calls = new WeakMap<XMLHttpRequest, { method: string; url: string; contentType?: string }>();
  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const target = calls.get(this);
    if (target && name.toLowerCase() === "content-type") target.contentType = value;
    return setRequestHeader.call(this, name, value);
  };
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
      const out = call(target.method, target.url, body, target.contentType);
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

  // Errors already recorded: one that reaches window and the app's framework too (Angular's ErrorHandler listens on
  // window as well) counts once.
  const recorded = new WeakSet<object>();

  function error(thrown: unknown): void {
    if (typeof thrown === "object" && thrown !== null) {
      if (recorded.has(thrown)) return;
      recorded.add(thrown);
      // A framework's own Error for an ErrorEvent with no error in it (a script of another origin): window's listener
      // recorded the event's message already.
      if (thrown instanceof Error && thrown.cause instanceof Event) return;
    }
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
          // An Error as it reads ("TypeError: …"): JSON has none of its fields (Angular's ErrorHandler logs one).
          message: args
            .map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? String(arg) : JSON.stringify(arg)))
            .join(" "),
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

  (globalThis as Record<symbol, Recording>)[RECORDING] = {
    report: error,
    route(template, title) {
      const path = location.pathname;
      routed = { path, template, title };
      // The view of this page (and what the user did on it) started before its router matched: named again, before
      // it goes out.
      const current = view;
      if (!current || current.trace.attrs["page.path"] !== path) return;
      const action = current.trace.attrs["page.action"];
      const name = typeof action === "string" ? `${template} › ${action}` : template;
      current.trace.name = name;
      current.root.name = name;
      current.trace.attrs["page.route"] = template;
      current.trace.attrs["page.title"] = title ?? document.title;
      announce(current.trace, true);
    },
  };

  // The first view started when the browser began loading the page.
  start("load", undefined, Math.round(performance.timeOrigin * 1000));
}
