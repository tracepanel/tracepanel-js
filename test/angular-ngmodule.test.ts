// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://app.test/","settings":{"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import "@angular/compiler";
import { Component, NgModule, provideZoneChangeDetection } from "@angular/core";
import { BrowserModule, platformBrowser } from "@angular/platform-browser";
import { expect, test, vi } from "vitest";
import { provideTracepanel } from "../src/angular.js";
import { record } from "../src/browser.js";
import { zoneless } from "./angular-change-detection.js";

vi.mock("../src/browser.js", () => ({ record: vi.fn(), report: vi.fn(), route: vi.fn() }));
const zoned = process.env["TRACEPANEL_ANGULAR_ZONE"] === "1";
if (zoned) await import("zone.js");
const App = Component({ selector: "module-app", standalone: false, template: "Library" })(class {});
const Module = NgModule({
  imports: [BrowserModule],
  declarations: [App],
  bootstrap: [App],
  providers: [zoned ? provideZoneChangeDetection() : zoneless(), provideTracepanel()],
})(class {});
test("an NgModule app starts recording with its configured change detection", async () => {
  document.body.append(document.createElement("module-app"));
  const platform = platformBrowser();
  const app = await platform.bootstrapModule(Module);
  expect(record).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Library");
  app.destroy();
  platform.destroy();
});
