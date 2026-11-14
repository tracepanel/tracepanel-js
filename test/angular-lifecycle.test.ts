// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import "@angular/compiler";
import { LocationStrategy } from "@angular/common";
import { type ApplicationRef, Component, ErrorHandler, PLATFORM_ID } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { NavigationEnd, PRIMARY_OUTLET, ROUTES, Router } from "@angular/router";
import { Subject } from "rxjs";
import { afterEach, expect, test, vi } from "vitest";
import { provideTracepanel } from "../src/angular.js";
import { record, report, route } from "../src/browser.js";
import { zoneless } from "./angular-change-detection.js";

vi.mock("../src/browser.js", () => ({ record: vi.fn(), report: vi.fn(), route: vi.fn() }));
const App = Component({ selector: "app-root", template: "" })(class {});
const apps: ApplicationRef[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.destroy();
  document.body.replaceChildren();
  for (const script of document.head.querySelectorAll("script")) script.remove();
  vi.clearAllMocks();
});

async function bootstrap(providers: Parameters<typeof bootstrapApplication>[1] = { providers: [] }) {
  document.body.append(document.createElement("app-root"));
  const app = await bootstrapApplication(App, {
    providers: [zoneless(), ...(providers.providers ?? [])],
  });
  apps.push(app);
  return app;
}

test("duplicate providers start once and restore the original error handler on destroy", async () => {
  const handler = new ErrorHandler();
  const original = vi.fn();
  handler.handleError = original;
  const app = await bootstrap({
    providers: [
      { provide: ErrorHandler, useValue: handler },
      provideTracepanel({ api: "/console" }),
      provideTracepanel(),
    ],
  });
  expect(record).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ api: "/console/" }));
  expect(document.querySelector("script")?.getAttribute("src")).toBe("/console/widget.min.js");
  const error = new Error("failure");
  handler.handleError(error);
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
  expect(original).toHaveBeenCalledExactlyOnceWith(error);
  app.destroy();
  apps.splice(apps.indexOf(app), 1);
  expect(handler.handleError).toBe(original);
});

test("a server injector does not start the browser recorder or modify its error handler", async () => {
  const handler = new ErrorHandler();
  const original = handler.handleError;
  await bootstrap({
    providers: [
      { provide: PLATFORM_ID, useValue: "server" },
      { provide: ErrorHandler, useValue: handler },
      provideTracepanel(),
    ],
  });
  expect(record).not.toHaveBeenCalled();
  expect(handler.handleError).toBe(original);
  expect(document.querySelector("script")).toBeNull();
});

test("route naming follows the primary outlet and stops when the app is destroyed", async () => {
  const events = new Subject<NavigationEnd>();
  const auxiliary = { outlet: "tools", routeConfig: { path: "tools" }, children: [], firstChild: null };
  const primary = {
    outlet: PRIMARY_OUTLET,
    routeConfig: { path: "books/:id" },
    title: "A book",
    children: [],
    firstChild: null,
  };
  const root = { children: [auxiliary, primary], firstChild: auxiliary };
  const app = await bootstrap({
    providers: [
      { provide: ROUTES, useValue: [] },
      { provide: Router, useValue: { events, routerState: { snapshot: { root } } } },
      { provide: LocationStrategy, useValue: { getBaseHref: () => "/library/" } },
      provideTracepanel(),
    ],
  });
  events.next(new NavigationEnd(1, "/books/2", "/books/2"));
  expect(route).toHaveBeenCalledExactlyOnceWith("/library/books/:id", "A book");
  app.destroy();
  apps.splice(apps.indexOf(app), 1);
  events.next(new NavigationEnd(2, "/books/3", "/books/3"));
  expect(route).toHaveBeenCalledTimes(1);
});
