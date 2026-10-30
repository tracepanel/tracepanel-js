// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://app.test/books"}
// @tracepanel/js/browser in a page: its load, what the user does, the calls each makes, its console, a route change.
// One recording for the page, as in a browser: the tests follow one another on it.
import { beforeAll, expect, test } from "vitest";
import { record } from "../src/browser.js";
import { noise } from "./ignored/noise.js";
import { wrapConsole } from "./overlay.js";

interface Doc {
  id: string;
  kind: string;
  name: string;
  status: string;
  attrs: Record<string, unknown>;
  spans: Doc[];
  logs: { message: string; attrs: Record<string, unknown> }[];
}

const PAGE = Symbol.for("tracepanel.page");
const sent: Doc[] = [];
const requests: Request[] = [];
const announced: { id: string; name: string; open: boolean }[] = [];
// The page's XMLHttpRequests: the URL each was opened for and the headers set on it, answered at once.
const xhrs: { url: string; headers: Record<string, string> }[] = [];
// The slow call's answer: it waits until the test lets it go.
let answerSlow: () => void = () => undefined;

/** The trace named so once the recording sent it: a view or an action ends when nothing happened for a second. */
async function sentTrace(name: string): Promise<Doc> {
  for (let waited = 0; waited < 5000; waited += 50) {
    const found = sent.find((trace) => trace.name === name);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no trace named ${name}; sent: ${sent.map((trace) => trace.name).join(", ")}`);
}

/** A button the user clicks, which calls `url`. */
function button(label: string, url: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  element.addEventListener("click", () => void fetch(url));
  document.body.append(element);
  return element;
}

beforeAll(() => {
  // The page's network: the console takes the traces, the API answers, /boom with a 500, /slow when let go; /down
  // never answers (fetch rejects).
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/__tracepanel__/api/ingest")) {
      sent.push(...(JSON.parse(await request.text()) as Doc[]));
      return new Response(null, { status: 202 });
    }
    requests.push(request);
    if (request.url.includes("down")) throw new TypeError("Failed to fetch");
    if (request.url.includes("slow")) await new Promise<void>((resolve) => (answerSlow = resolve));
    return new Response("{}", { status: request.url.includes("boom") ? 500 : 200 });
  };
  const opened = new WeakMap<XMLHttpRequest, { url: string; headers: Record<string, string> }>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, _method: string, url: string | URL) {
    const sent = { url: String(url), headers: {} };
    opened.set(this, sent);
    xhrs.push(sent);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const sent = opened.get(this);
    if (sent) sent.headers[name] = value;
  };
  // Answered with a 200 at once; /down with no answer (a network error).
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest) {
    if (opened.get(this)?.url.includes("down")) this.dispatchEvent(new Event("error"));
    else Object.defineProperty(this, "status", { value: 200 });
    this.dispatchEvent(new Event("loadend"));
  };
  window.addEventListener("tracepanel:page", (event) => announced.push((event as CustomEvent).detail));
  // The helper's folder stands for a dev server's own scripts (/@vite/ under Vite).
  // (Vitest runs from the project's root; the page's import.meta.url isn't the file's.)
  const ignored = `${process.cwd()}/test/ignored/`;
  record({ service: "shop-web", propagateTo: ["http://api.test"], ignoreSources: [ignored] });
});

test("the page's load is a view, announced as it starts and as it ends", async () => {
  const view = await sentTrace("/books");

  expect(view.attrs).toMatchObject({
    "service.name": "shop-web",
    "service.role": "browser",
    "page.path": "/books",
    "page.trigger": "load",
  });
  expect(view.attrs["page.action"]).toBeUndefined();
  expect(announced.filter((item) => item.name === "/books").map((item) => item.open)).toEqual([true, false]);
});

test("a click that calls the API is an action named after its control, its call linked to the API's trace", async () => {
  button("Save", "/api/books").click();
  const action = await sentTrace('/books › click "Save"');
  const call = action.spans.find((span) => span.kind === "http.client");
  const request = requests.find((item) => item.url === "http://app.test/api/books");
  const spanId = call?.attrs["w3c.span_id"];

  expect(action.attrs).toMatchObject({ "page.trigger": "click", "page.action": 'click "Save"' });
  expect(call?.name).toBe("GET app.test/api/books");
  expect(request?.headers.get("traceparent")).toBe(`00-${action.attrs["w3c.trace_id"]}-${spanId}-01`);
});

test("each response carries the action that made it, for the widget", async () => {
  let marked: unknown;
  const element = document.createElement("button");
  element.textContent = "Reload";
  element.addEventListener("click", () => {
    void fetch("/api/books?page=2").then(
      (response) => (marked = (response as unknown as Record<symbol, unknown>)[PAGE]),
    );
  });
  document.body.append(element);
  element.click();
  const action = await sentTrace('/books › click "Reload"');

  expect(marked).toBe(action.id);
});

test("a wrapper of fetch around the recording's (the widget's) finds the action's mark as the Response reaches it", async () => {
  const recording = window.fetch;
  let marked: unknown;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await recording(input, init);
    marked = (response as unknown as Record<symbol, unknown>)[PAGE];
    return response;
  };
  button("Refresh", "/api/books?page=3").click();
  const action = await sentTrace('/books › click "Refresh"');
  window.fetch = recording;

  expect(marked).toBe(action.id);
});

test("a traceparent goes to the page's origin and to propagateTo's, not to others", async () => {
  button("Sync", "http://api.test/sync").click();
  await sentTrace('/books › click "Sync"');
  button("Track", "http://other.test/track").click();
  await sentTrace('/books › click "Track"');

  expect(requests.find((item) => item.url === "http://api.test/sync")?.headers.has("traceparent")).toBe(true);
  expect(requests.find((item) => item.url === "http://other.test/track")?.headers.has("traceparent")).toBe(false);
});

/** The panel's Profile toggle, as it sets its cookie: "1", "memory", or off. */
function profileCookie(value: string | undefined): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the panel sets it so; the recording reads document.cookie.
  document.cookie = value ? `tracepanel_profile=${value}; Path=/` : "tracepanel_profile=; Max-Age=0; Path=/";
}

/** The headers a call sent, by name in lower case: those the profile and the trace context ask with. */
function asking(url: string): Record<string, string | null> {
  const headers = requests.find((item) => item.url === url)?.headers;
  return {
    traceparent: headers?.has("traceparent") ? "set" : null,
    profile: headers?.get("x-tracepanel-profile") ?? null,
  };
}

test("while the panel's Profile is on, calls that carry a traceparent ask for a profile with its value", async () => {
  profileCookie("1");
  button("Profile own", "/api/profiled").click();
  await sentTrace('/books › click "Profile own"');
  button("Profile api", "http://api.test/profiled").click();
  await sentTrace('/books › click "Profile api"');
  button("Profile other", "http://other.test/profiled").click();
  await sentTrace('/books › click "Profile other"');
  profileCookie("memory");
  button("Profile memory", "http://api.test/memory").click();
  await sentTrace('/books › click "Profile memory"');
  profileCookie(undefined);
  button("Profile off", "http://api.test/off").click();
  await sentTrace('/books › click "Profile off"');

  expect(asking("http://app.test/api/profiled")).toEqual({ traceparent: "set", profile: "1" });
  expect(asking("http://api.test/profiled")).toEqual({ traceparent: "set", profile: "1" });
  expect(asking("http://other.test/profiled")).toEqual({ traceparent: null, profile: null });

  expect(asking("http://api.test/memory")).toEqual({ traceparent: "set", profile: "memory" });

  expect(asking("http://api.test/off")).toEqual({ traceparent: "set", profile: null });
}, 15_000);

test("a call that asks for a profile itself keeps its own ask", async () => {
  profileCookie("memory");
  const element = document.createElement("button");
  element.textContent = "Own ask";
  element.addEventListener("click", () => void fetch("/api/own-ask", { headers: { "X-Tracepanel-Profile": "1" } }));
  document.body.append(element);
  element.click();
  await sentTrace('/books › click "Own ask"');
  profileCookie(undefined);

  expect(asking("http://app.test/api/own-ask")).toEqual({ traceparent: "set", profile: "1" });
});

test("an XMLHttpRequest asks as fetch() does", async () => {
  /** A click that sends an XMLHttpRequest to `url`. */
  const xhr = (label: string, url: string) => {
    const element = document.createElement("button");
    element.textContent = label;
    element.addEventListener("click", () => {
      const request = new XMLHttpRequest();
      request.open("GET", url);
      request.send();
    });
    document.body.append(element);
    element.click();
  };
  profileCookie("memory");
  xhr("Xhr api", "http://api.test/xhr");
  await sentTrace('/books › click "Xhr api"');
  xhr("Xhr other", "http://other.test/xhr");
  await sentTrace('/books › click "Xhr other"');
  profileCookie(undefined);
  xhr("Xhr off", "/api/xhr");
  await sentTrace('/books › click "Xhr off"');
  const headers = (url: string) => {
    const found = xhrs.find((item) => item.url === url)?.headers ?? {};
    return { ...found, ...(found.traceparent ? { traceparent: "set" } : {}) };
  };

  expect(headers("http://api.test/xhr")).toEqual({ traceparent: "set", "X-Tracepanel-Profile": "memory" });
  expect(headers("http://other.test/xhr")).toEqual({});
  expect(headers("/api/xhr")).toEqual({ traceparent: "set" });
}, 15_000);

test("a call that fails fails its action", async () => {
  button("Delete", "/api/boom").click();
  const action = await sentTrace('/books › click "Delete"');

  expect(action.status).toBe("error");
  expect(action.spans.find((span) => span.kind === "http.client")?.status).toBe("error");
});

test("the console in an action keeps where it was logged; a dev server's own client's is left out", async () => {
  const element = document.createElement("button");
  element.textContent = "Log";
  element.addEventListener("click", () => {
    void fetch("/api/books").then(() => {
      // biome-ignore lint/suspicious/noConsole: the page's own log, which the recording keeps.
      console.info("loaded the books");
      noise();
    });
  });
  document.body.append(element);
  element.click();
  const action = await sentTrace('/books › click "Log"');

  expect(action.logs.map((log) => log.message)).toEqual(["loaded the books"]);
  expect(String(action.logs[0]?.attrs && (action.logs[0].attrs as Record<string, unknown>)["code.filepath"])).toMatch(
    /browser\.test\.ts$/,
  );
});

test("a wrapper of console installed after the recording (Next.js's dev overlay) doesn't hide who logged", async () => {
  const unwrap = wrapConsole("warn");
  const element = document.createElement("button");
  element.textContent = "Warn";
  element.addEventListener("click", () => {
    void fetch("/api/books").then(() => {
      // biome-ignore lint/suspicious/noConsole: the page's own log, which the recording keeps.
      console.warn("low stock");
    });
  });
  document.body.append(element);
  element.click();
  const action = await sentTrace('/books › click "Warn"');
  unwrap();

  expect(action.logs.map((log) => [log.message, String(log.attrs["code.filepath"]).split("/").at(-1)])).toEqual([
    ["low stock", "browser.test.ts"],
  ]);
});

test("calls nobody started are background", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await fetch("/api/poll");

  expect((await sentTrace("/books › background")).attrs["page.trigger"]).toBe("background");
});

test("an SPA's route change starts a view of the new page", async () => {
  history.pushState({}, "", "/books/2");

  expect((await sentTrace("/books/2")).attrs).toMatchObject({ "page.path": "/books/2", "page.trigger": "navigation" });
});

/** The page's call to `url` in `trace`. */
function callTo(trace: Doc, url: string): Doc & { duration: number } {
  const found = trace.spans.find((span) => span.kind === "http.client" && span.attrs["url.full"] === url);
  if (!found) throw new Error(`no call to ${url} in ${trace.name}`);
  return found as Doc & { duration: number };
}

test("an answered call keeps its status code, a 5xx failing it", async () => {
  const action = await sentTrace('/books › click "Delete"');

  expect(callTo(action, "http://app.test/api/boom")).toMatchObject({
    status: "error",
    attrs: {
      "http.request.method": "GET",
      "url.full": "http://app.test/api/boom",
      "http.response.status_code": 500,
    },
  });
  expect(callTo(action, "http://app.test/api/boom").attrs).not.toHaveProperty("error.type");

  const view = await sentTrace('/books › click "Log"');

  expect(callTo(view, "http://app.test/api/books")).toMatchObject({
    status: "ok",
    attrs: { "http.response.status_code": 200 },
  });
  expect(callTo(view, "http://app.test/api/books").attrs).not.toHaveProperty("error.type");
  expect(callTo(view, "http://app.test/api/books").attrs).not.toHaveProperty("http.unfinished");
});

test("a fetch() with no answer fails with why, not a status code of 0", async () => {
  const element = document.createElement("button");
  element.textContent = "Offline";
  element.addEventListener("click", () => void fetch("/api/down").catch(() => undefined));
  document.body.append(element);
  element.click();
  const action = await sentTrace('/books/2 › click "Offline"');
  const call = callTo(action, "http://app.test/api/down");

  expect(action.status).toBe("error");
  expect(call.status).toBe("error");
  expect(call.attrs).toEqual({
    "http.request.method": "GET",
    "url.full": "http://app.test/api/down",
    "url.scheme": "http",
    "server.address": "app.test",
    "server.port": 80,
    "w3c.span_id": expect.any(String),
    "error.type": "TypeError",
  });
});

test("an XMLHttpRequest with no answer fails with why; an answered one keeps its status code", async () => {
  const element = document.createElement("button");
  element.textContent = "Xhr down";
  element.addEventListener("click", () => {
    for (const url of ["/api/down", "/api/xhr-ok"]) {
      const request = new XMLHttpRequest();
      request.open("GET", url);
      request.send();
    }
  });
  document.body.append(element);
  element.click();
  const action = await sentTrace('/books/2 › click "Xhr down"');
  const failed = callTo(action, "http://app.test/api/down");
  const answered = callTo(action, "http://app.test/api/xhr-ok");

  expect(failed.status).toBe("error");
  expect(failed.attrs["error.type"]).toBe("NetworkError");
  expect(failed.attrs).not.toHaveProperty("http.response.status_code");

  expect(answered.status).toBe("ok");
  expect(answered.attrs["http.response.status_code"]).toBe(200);
  expect(answered.attrs).not.toHaveProperty("error.type");
});

test("a view that ends with a call still open closes it as unfinished, then ignores its late answer", async () => {
  history.pushState({}, "", "/orders");
  const slow = fetch("/api/slow");
  await new Promise((resolve) => setTimeout(resolve, 50));
  history.pushState({}, "", "/orders/1");
  const view = await sentTrace("/orders");
  const call = callTo(view, "http://app.test/api/slow");

  expect(call.duration).toBeGreaterThanOrEqual(40_000);
  expect(call.status).toBe("ok");
  expect(call.attrs).toEqual({
    "http.request.method": "GET",
    "url.full": "http://app.test/api/slow",
    "url.scheme": "http",
    "server.address": "app.test",
    "server.port": 80,
    "w3c.span_id": expect.any(String),
    "http.unfinished": true,
  });

  answerSlow();
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 1200));

  expect(sent.filter((trace) => trace.name === "/orders")).toHaveLength(1);
});
