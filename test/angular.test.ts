// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://app.test/books/7", "settings": {"disableJavaScriptFileLoading": true, "handleDisabledFileLoadingAsSuccess": true}}
// @tracepanel/js/angular in an Angular app (zoneless, as Angular makes one): the recording started with the app, the
// widget in the page, the views named by their routes, the errors ErrorHandler catches, HttpClient's calls under the
// click that made them. One app for the page, as in a browser: the tests follow one another on it.
import "@angular/compiler";
import { HttpClient, provideHttpClient, withFetch } from "@angular/common/http";
import {
  type ApplicationRef,
  Component,
  ErrorHandler,
  inject,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, Router, RouterOutlet } from "@angular/router";
import { beforeAll, expect, test } from "vitest";
import { provideTracepanel } from "../src/angular.js";

interface Doc {
  name: string;
  attrs: Record<string, unknown>;
  spans: { kind: string; name: string; parent_id: string | null; id: string; attrs: Record<string, unknown> }[];
  errors: { type: string; message: string; handled: boolean }[];
  logs: { message: string }[];
}

const sent: Doc[] = [];
const requests: Request[] = [];
// What the app's ErrorHandler got after the recording did: the app's own handling goes on.
const handled: unknown[] = [];
let app: ApplicationRef;

/**
 * The `nth` trace named so once the recording sent it (the first by default): a view or an action ends when nothing
 * happened for a second.
 */
async function sentTrace(name: string, nth = 1): Promise<Doc> {
  for (let waited = 0; waited < 5000; waited += 50) {
    const found = sent.filter((trace) => trace.name === name)[nth - 1];
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no trace named ${name}; sent: ${sent.map((trace) => trace.name).join(", ")}`);
}

/** The page's button with this text. */
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

/** A book's page: Borrow calls the API through HttpClient, Share throws (the API sends no isbn). */
const BookPage = Component({
  selector: "app-book",
  template: `<button type="button" (click)="borrow()">Borrow</button><button type="button" (click)="share()">Share</button>`,
})(
  class {
    private readonly http = inject(HttpClient);

    borrow(): void {
      this.http.post("/api/books/7/loans", { member: "alex" }).subscribe();
    }

    share(): void {
      const book = {} as { isbn: string };
      void book.isbn.toUpperCase();
    }
  },
);

const Books = Component({ selector: "app-books", template: "<p>Books</p>" })(class {});

const App = Component({ selector: "app-root", imports: [RouterOutlet], template: "<router-outlet />" })(class {});

beforeAll(async () => {
  // The page's network: the console takes the traces, the API answers.
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/__tracepanel__/api/ingest")) {
      sent.push(...(JSON.parse(await request.text()) as Doc[]));
      return new Response(null, { status: 202 });
    }
    requests.push(request);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const base = document.createElement("base");
  base.href = "/";
  document.head.append(base);
  document.body.append(document.createElement("app-root"));
  app = await bootstrapApplication(App, {
    providers: [
      // Angular 20 and 21 still default to zone.js.
      provideZonelessChangeDetection(),
      provideBrowserGlobalErrorListeners(),
      provideRouter([
        { path: "", component: Books, title: "Books" },
        { path: "books/:id", component: BookPage, title: "A book" },
      ]),
      // HttpClient on fetch(): its backend looks fetch up as it calls.
      provideHttpClient(withFetch()),
      {
        provide: ErrorHandler,
        useValue: {
          handleError(error: unknown) {
            handled.push(error);
            // biome-ignore lint/suspicious/noConsole: as Angular's own ErrorHandler logs it.
            console.error("ERROR", error);
          },
        },
      },
      provideTracepanel({ service: "library-web", propagateTo: ["http://api.test"] }),
    ],
  });
});

test("the widget's script goes into the page once, with the console's address", () => {
  const scripts = [...document.querySelectorAll<HTMLScriptElement>("script[data-tracepanel-api]")];

  expect(scripts.map((script) => [script.getAttribute("src"), script.dataset["tracepanelApi"], script.defer])).toEqual([
    ["/__tracepanel__/widget.min.js", "/__tracepanel__/", true],
  ]);
});

test("the page's load is a view named by the route it matched, its path and title kept", async () => {
  const view = await sentTrace("/books/:id");

  expect(view.attrs).toMatchObject({
    "service.name": "library-web",
    "page.path": "/books/7",
    "page.route": "/books/:id",
    "page.title": "A book",
    "page.trigger": "load",
  });
});

test("an HttpClient call is the click's that made it, with a traceparent", async () => {
  button("Borrow").click();
  const action = await sentTrace('/books/:id › click "Borrow"');
  const [root, call] = action.spans;
  const request = requests.find((item) => item.url === "http://app.test/api/books/7/loans");

  expect(action.attrs).toMatchObject({ "page.route": "/books/:id", "page.action": 'click "Borrow"' });
  expect(call).toMatchObject({ kind: "http.client", name: "POST app.test/api/books/7/loans", parent_id: root?.id });
  expect(request?.headers.get("traceparent")).toBe(
    `00-${action.attrs["w3c.trace_id"]}-${call?.attrs["w3c.span_id"]}-01`,
  );
});

test("an error Angular's ErrorHandler caught fails the click, and the app's handler still gets it", async () => {
  button("Share").click();
  const action = await sentTrace('/books/:id › click "Share"');

  expect(action.errors).toMatchObject([
    { type: "TypeError", message: "Cannot read properties of undefined (reading 'toUpperCase')", handled: false },
  ]);
  expect(action.logs.map((log) => log.message)).toEqual([
    "ERROR TypeError: Cannot read properties of undefined (reading 'toUpperCase')",
  ]);
  expect(handled).toEqual([expect.any(TypeError)]);
});

test("an error that reaches window and ErrorHandler both counts once", async () => {
  const thrown = new RangeError("out of shelves");
  button("Borrow").click();
  window.dispatchEvent(new ErrorEvent("error", { error: thrown, message: thrown.message }));
  const action = await sentTrace('/books/:id › click "Borrow"', 2);

  expect(handled).toContain(thrown);
  expect(action.errors).toMatchObject([{ type: "RangeError", message: "out of shelves" }]);
});

test("a route change's view is named by its route", async () => {
  await app.injector.get(Router).navigateByUrl("/");

  expect((await sentTrace("/")).attrs).toMatchObject({
    "page.path": "/",
    "page.route": "/",
    "page.title": "Books",
    "page.trigger": "navigation",
  });
});
