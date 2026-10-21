// The request's session as the app left it, for the Request tab: express-session's and cookie-session's in Express
// (and Nest, on it), the sessions h3's useSession() read in Nuxt. Values as text, secrets masked at any depth.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import cookieSession from "cookie-session";
import express from "express";
import session from "express-session";
import { createApp, eventHandler, toNodeListener, useSession } from "h3";
import { afterAll, describe, expect, it } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { tracepanel as middleware } from "../src/express.js";
import type { Attrs } from "../src/model.js";
import tracepanelPlugin from "../src/nuxt-plugin.js";
import type { TracepanelProcessor } from "../src/processor.js";
import type { Runtime } from "../src/runtime.js";
import { sessionAttrs } from "../src/session.js";

const KEY = Symbol.for("tracepanel.runtime");
const MASK = "********";

/** What went into the trace's attributes, by the last request. */
let recorded: Attrs = {};
const processor = {
  timing: () => undefined,
  framework: () => "Express",
  setFramework: () => {},
  setRoute: () => {},
  addLog: () => {},
  addError: () => {},
  setTraceAttrs: (attrs: Attrs) => Object.assign(recorded, attrs),
} as unknown as TracepanelProcessor;
const tracepanel: Runtime = {
  config: { ...loadConfig({}), enabled: true },
  processor,
  starter: {} as Starter,
  console: { get: () => "" } as unknown as ConsoleUrl,
  badge: () => undefined,
};
(globalThis as Record<symbol, unknown>)[KEY] = tracepanel;

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The session.* attributes the request recorded, and the cookie it set. */
async function sessionOf(url: string, cookie?: string): Promise<{ attrs: Attrs; cookie: string }> {
  recorded = {};
  const response = await fetch(url, { headers: cookie ? { cookie } : {} });
  await response.arrayBuffer();
  const attrs = Object.fromEntries(Object.entries(recorded).filter(([name]) => name.startsWith("session.")));
  const set = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return { attrs, cookie: set.join("; ") };
}

describe("a session's attributes", () => {
  it("are its values as text, masked under a sensitive name and below one, a signed-in user's kept", () => {
    expect(
      sessionAttrs(
        Object.entries({
          userId: 42,
          "cart-items": [{ id: 1, token: "t0k3n" }],
          csrfSecret: "abc",
          passport: { user: 42 },
          secure: { apiToken: "t0k3n" },
          flash: "Saved",
        }),
      ),
    ).toEqual({
      "session.userid": "42",
      "session.cart_items": `[ { id: 1, token: '${MASK}' } ]`,
      "session.csrfsecret": MASK,
      "session.passport": "{ user: 42 }",
      "session.secure": MASK,
      "session.flash": "'Saved'",
    });
  });
});

describe("Express", () => {
  it("records express-session's session as the handler left it, and as the next request loads it", async () => {
    const app = express();
    app.use(middleware());
    app.use(session({ secret: "test", resave: false, saveUninitialized: false }));
    app.get("/login", (req, res) => {
      Object.assign(req.session, { passport: { user: 42 }, csrfSecret: "abc" });
      res.json({ ok: true });
    });
    app.get("/cart", (req, res) => {
      (req.session as unknown as { cart: number[] }).cart = [7];
      res.json({ ok: true });
    });
    const base = await listen(app);

    const login = await sessionOf(`${base}/login`);
    const cart = await sessionOf(`${base}/cart`, login.cookie);

    expect(login.attrs).toEqual({ "session.passport": "{ user: 42 }", "session.csrfsecret": MASK });

    expect(cart.attrs).toEqual({
      "session.passport": "{ user: 42 }",
      "session.csrfsecret": MASK,
      "session.cart": "[ 7 ]",
    });
  });

  it("records cookie-session's session", async () => {
    const app = express();
    app.use(middleware());
    app.use(cookieSession({ keys: ["test"] }));
    app.get("/visit", (req, res) => {
      const visits = req.session as { views?: number };
      visits.views = (visits.views ?? 0) + 1;
      res.json({ ok: true });
    });
    const base = await listen(app);

    const first = await sessionOf(`${base}/visit`);
    const second = await sessionOf(`${base}/visit`, first.cookie);

    expect(first.attrs).toEqual({ "session.views": "1" });

    expect(second.attrs).toEqual({ "session.views": "2" });
  });

  it("records none without a session middleware", async () => {
    const app = express();
    app.use(middleware());
    app.get("/", (_req, res) => {
      res.json({ ok: true });
    });
    const base = await listen(app);

    expect((await sessionOf(`${base}/`)).attrs).toEqual({});
  });
});

describe("Nuxt", () => {
  type Hook = (event: unknown) => void;
  const hooks: Record<string, Hook> = {};
  tracepanelPlugin({ hooks: { hook: (name: string, handler: Hook) => (hooks[name] = handler) } } as never);
  const password = "a-password-of-at-least-32-characters";

  async function nuxt(handler: Parameters<typeof eventHandler>[0]): Promise<string> {
    const app = createApp({ onBeforeResponse: (event) => hooks.beforeResponse?.(event) });
    app.use(eventHandler(handler));
    return listen(toNodeListener(app));
  }

  it("records the session useSession() read, as the handler left it", async () => {
    const base = await nuxt(async (event) => {
      const user = await useSession(event, { password, name: "nuxt-session" });
      await user.update({ user: { name: "Ann", password: "hunter2" }, secure: { apiToken: "t0k3n" } });
      return { ok: true };
    });

    expect((await sessionOf(`${base}/login`)).attrs).toEqual({
      "session.user": `{ name: 'Ann', password: '${MASK}' }`,
      "session.secure": MASK,
    });
  });

  it("names each session when the request read several", async () => {
    const base = await nuxt(async (event) => {
      await (await useSession(event, { password, name: "cart" })).update({ items: 2 });
      await (await useSession(event, { password, name: "prefs" })).update({ theme: "dark" });
      return { ok: true };
    });

    expect((await sessionOf(`${base}/`)).attrs).toEqual({ "session.cart.items": "2", "session.prefs.theme": "'dark'" });
  });

  it("records none for a request that read no session", async () => {
    const base = await nuxt(() => ({ ok: true }));

    expect((await sessionOf(`${base}/`)).attrs).toEqual({});
  });
});
