// An Angular app's pages, recorded in the browser, and the badge on them: `provideTracepanel()` in the app's
// providers.
//
//   // app.config.ts
//   import { provideTracepanel } from "@tracepanel/js/angular";
//   export const config: ApplicationConfig = {
//     providers: [provideRouter(routes), provideHttpClient(), provideTracepanel({ service: "shop-web" })],
//   };
//
// In a development build only (isDevMode()), it starts @tracepanel/js/browser's recording as the app's injector is
// made, before any of its services, and so before HttpClient makes a call. It puts the widget's script in the page,
// gives the recording the errors Angular's ErrorHandler catches (an event handler's, a component's), which never
// reach window, and names each view by the route the router matched ("/books/:id"). The console is the one the dev
// server sends /__tracepanel__/ on to (proxy.conf.json).

import { LocationStrategy } from "@angular/common";
import {
  type EnvironmentProviders,
  ErrorHandler,
  inject,
  isDevMode,
  makeEnvironmentProviders,
  NgZone,
  PLATFORM_ID,
  provideEnvironmentInitializer,
} from "@angular/core";
import { type ActivatedRouteSnapshot, NavigationEnd, ROUTES, Router } from "@angular/router";
import { type BrowserOptions, record, report, route } from "./browser.js";

export { report };

export interface TracepanelAngularOptions {
  /** The app's name in the console. "browser" by default. */
  service?: string;
  /**
   * Other origins whose calls carry a traceparent, and X-Tracepanel-Profile while the panel's Profile is on: their
   * CORS must allow both headers.
   */
  propagateTo?: string[];
  /** Where the dev server sends the console on, on the page's origin: "/__tracepanel__/" by default. */
  api?: string;
}

// The dev server's own client (Vite's, under the Angular CLI's dev server): its console output isn't the page's.
const DEV_SOURCES = ["/@vite/"];

/** The recording, the widget, ErrorHandler's errors and the views' routes, in a development build in a browser. */
export function provideTracepanel(options: TracepanelAngularOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      if (!isDevMode() || inject(PLATFORM_ID) !== "browser") return;
      const api = options.api ?? "/__tracepanel__/";
      const settings: BrowserOptions = { api, ignoreSources: DEV_SOURCES };
      if (options.service !== undefined) settings.service = options.service;
      if (options.propagateTo !== undefined) settings.propagateTo = options.propagateTo;
      // Outside Angular's zone, where there is one: the recording's own listeners and timers aren't the app's work.
      inject(NgZone).runOutsideAngular(() => record(settings));
      widget(api);
      catchErrors(inject(ErrorHandler));
      // The router's routes, when the app has a router.
      if (inject(ROUTES, { optional: true })) nameViews(inject(Router), inject(LocationStrategy).getBaseHref());
    }),
  ]);
}

/** The widget's script, after the recording started: its fetch() wraps the recording's. Once per page. */
function widget(api: string): void {
  if (document.querySelector("script[data-tracepanel-api]")) return;
  const script = document.createElement("script");
  script.src = `${api}widget.min.js`;
  script.dataset["tracepanelApi"] = api;
  script.defer = true;
  document.head.append(script);
}

/**
 * The app's ErrorHandler, whichever it is (Angular's, Sentry's, the app's own), passes each error to the recording
 * first: Angular catches what an event handler or a component throws, and it never reaches window.
 */
function catchErrors(handler: ErrorHandler): void {
  const handle = handler.handleError.bind(handler);
  handler.handleError = (error: unknown) => {
    report(error);
    handle(error);
  };
}

/** Each navigation's view named by the route it matched, under the app's base href, and that route's title. */
function nameViews(router: Router, baseHref: string): void {
  const base = baseHref.replace(/\/$/, "");
  router.events.subscribe((event) => {
    if (!(event instanceof NavigationEnd)) return;
    const { template, title } = matched(router.routerState.snapshot.root);
    route(`${base}${template}`, title);
  });
}

/** The matched route's path, joined from the root down its primary outlet ("/books/:id"), and its deepest title. */
function matched(root: ActivatedRouteSnapshot): { template: string; title: string | undefined } {
  const parts: string[] = [];
  let title: string | undefined;
  for (let node: ActivatedRouteSnapshot | null = root; node; node = node.firstChild) {
    const path = node.routeConfig?.path;
    if (path) parts.push(path);
    title = node.title ?? title;
  }
  return { template: `/${parts.join("/")}`, title };
}
