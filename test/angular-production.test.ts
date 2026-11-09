// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://app.test/"}
// @tracepanel/js/angular in a production build (isDevMode() false): nothing recorded, no widget, fetch untouched.
import "@angular/compiler";
import { Component, enableProdMode } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, RouterOutlet } from "@angular/router";
import { expect, test } from "vitest";
import { provideTracepanel } from "../src/angular.js";

const App = Component({ selector: "app-root", imports: [RouterOutlet], template: "<router-outlet />" })(class {});

test("a production build records nothing and puts no widget in the page", async () => {
  const fetch = window.fetch;
  enableProdMode();
  const base = document.createElement("base");
  base.href = "/";
  document.head.append(base);
  document.body.append(document.createElement("app-root"));
  const app = await bootstrapApplication(App, {
    providers: [provideRouter([]), provideTracepanel({ service: "library-web" })],
  });

  expect(window.fetch).toBe(fetch);
  expect(document.querySelectorAll("script[data-tracepanel-api]")).toHaveLength(0);
  expect((globalThis as { __tracepanelRecording?: boolean }).__tracepanelRecording).toBeUndefined();

  app.destroy();
});
