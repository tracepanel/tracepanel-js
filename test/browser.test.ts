// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://app.test/books"}
// tracepanel/browser in a page: its load, what the user does, the calls each makes, its console, a route change.
// One recording for the page, as in a browser: the tests follow one another on it.
import { beforeAll, expect, test } from "vitest";
import { record } from "../src/browser.js";
import { noise } from "./ignored/noise.js";

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
  // The page's network: the console takes the traces, the API answers, /boom with a 500.
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/__tracepanel__/api/ingest")) {
      sent.push(...(JSON.parse(await request.text()) as Doc[]));
      return new Response(null, { status: 202 });
    }
    requests.push(request);
    return new Response("{}", { status: request.url.includes("boom") ? 500 : 200 });
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

test("a traceparent goes to the page's origin and to propagateTo's, not to others", async () => {
  button("Sync", "http://api.test/sync").click();
  await sentTrace('/books › click "Sync"');
  button("Track", "http://other.test/track").click();
  await sentTrace('/books › click "Track"');

  expect(requests.find((item) => item.url === "http://api.test/sync")?.headers.has("traceparent")).toBe(true);
  expect(requests.find((item) => item.url === "http://other.test/track")?.headers.has("traceparent")).toBe(false);
});

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

  expect(action.logs.map((log) => log["message"])).toEqual(["loaded the books"]);
  expect(
    String(action.logs[0]?.["attrs"] && (action.logs[0]["attrs"] as Record<string, unknown>)["code.filepath"]),
  ).toMatch(/browser\.test\.ts$/);
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
