// Next.js and Nuxt answer from their own server: as a response's headers go out, what its request carried goes into
// the trace (found by its URL when the response leaves the request's context), before the badge's headers join; a
// redirect answering a page's navigation sets the cookie the next page's panel reads.
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, expect, test } from "vitest";
import type { ConsoleUrl, Starter } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { headersOnResponses } from "../src/headers.js";
import type { Attrs } from "../src/model.js";
import type { TracepanelProcessor } from "../src/processor.js";
import type { Runtime } from "../src/runtime.js";
import { badge } from "../src/widget.js";

/** What went into the trace's attributes, and the request it was found by. */
let recorded: { attrs: Attrs; request: { method: string; url: string } | undefined } | undefined;
const processor = {
  timing: () => ({ id: "01TRACE", queries: 0, dbMs: 0, startedMs: performance.now() }),
  framework: () => "Next.js",
  setTraceAttrs: (attrs: Attrs, request?: { method: string; url: string }) => {
    recorded = { attrs, request };
  },
} as unknown as TracepanelProcessor;
const tracepanel: Runtime = {
  config: { ...loadConfig({}), enabled: true },
  processor,
  starter: {} as Starter,
  console: { get: () => "http://127.0.0.1:9/" } as unknown as ConsoleUrl,
  badge: (request) => badge(tracepanel, request),
};
headersOnResponses(tracepanel, "Next.js");

const app: Server = createServer((req, res) => {
  if (req.url?.startsWith("/action")) {
    res.setHeader("Set-Cookie", "flash=saved; Path=/");
    res.statusCode = 303;
    res.setHeader("Location", "/books");
    res.end();
  } else {
    res.writeHead(302, { Location: "/books", "Set-Cookie": "seen=1" });
    res.end();
  }
});
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

afterAll(() => app.close());

function send(path: string, headers: Record<string, string>): Promise<{ status: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(`${base}${path}`, { method: "POST", headers, agent: false }, (response) => {
      response.resume();
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, cookies: response.headers["set-cookie"] ?? [] }),
      );
    });
    sent.on("error", reject);
    sent.end();
  });
}

test("a server action's redirect: what its request carried is recorded, and the cookie names it for the next page", async () => {
  const answer = await send("/action?id=7&token=t", { "Sec-Fetch-Mode": "navigate", Cookie: "session=s; theme=dark" });

  expect(answer).toEqual({
    status: 303,
    cookies: ["flash=saved; Path=/", "tracepanel_redirect=01TRACE; Max-Age=30; Path=/; SameSite=Lax"],
  });

  expect(recorded).toEqual({
    attrs: {
      "http.request.header.sec_fetch_mode": "navigate",
      "http.request.header.host": base.slice("http://".length),
      "http.request.header.connection": "close",
      "http.request.header.content_length": "0",
      "url.query": "id=7&token=********",
      "http.request.cookie.session": "********",
      "http.request.cookie.theme": "dark",
      "http.response.header.set_cookie": "********",
      "http.response.header.location": "/books",
    },
    request: { method: "POST", url: "/action?id=7&token=t" },
  });
});

test("headers passed to writeHead are recorded too, and the cookie joins a Set-Cookie passed there", async () => {
  const answer = await send("/moved", { Accept: "text/html", Cookie: "tracepanel_redirect=01EARLIER" });

  expect(answer).toEqual({
    status: 302,
    cookies: ["seen=1", "tracepanel_redirect=01EARLIER%2C01TRACE; Max-Age=30; Path=/; SameSite=Lax"],
  });

  expect(recorded?.attrs).toEqual({
    "http.request.header.accept": "text/html",
    "http.request.header.host": base.slice("http://".length),
    "http.request.header.connection": "close",
    "http.request.header.content_length": "0",
    "http.request.cookie.tracepanel_redirect": "01EARLIER",
    "http.response.header.location": "/books",
    "http.response.header.set_cookie": "********",
  });
});
