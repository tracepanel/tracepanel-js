// `app.use(tracepanel())` on Hono served by @hono/node-server: the handler is a span named by its route, and so is
// the trace, a sub-app's route with its base path. A page gets the widget's script, whole or streamed; what the
// request carried goes into its trace, its body as far as the handler read it; an error answered with a 500 is the
// request's, with its locals; an HTTPException below 500 is an answer.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, expect, test } from "vitest";
import { tracepanel } from "../src/hono.js";
import { findBook, reserve } from "./app/books.js";
import { FORM, line, SCRIPT, send, traceOf, tree } from "./traced.js";

const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

function pieces(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

const app = new Hono();
app.use(tracepanel());
app.get("/books/:id", (c) => c.json(findBook(c.req.param("id"))));
app.post("/books", async (c) => c.json(await c.req.json()));
app.get("/page", (c) => c.html(PAGE));
app.get("/streamed", (c) =>
  c.body(pieces("<!doctype html><html><he", "ad><title>t</title></head>", "<body>x</body></html>"), 200, {
    "Content-Type": "text/html; charset=utf-8",
  }),
);
app.get("/reserve/:id", () => reserve("7", { name: "Ann", email: "ann@example.com" }));
app.get("/gone", () => {
  throw new HTTPException(404, { message: "no such book" });
});
app.post("/login", async (c) => {
  await c.req.parseBody();
  c.header("Set-Cookie", "sessionid=s3cr3t", { append: true });
  return c.redirect("/home", 303);
});
const books = new Hono();
books.get("/:id/reviews", (c) => c.json([]));
app.route("/api/books", books);
const server = serve({ fetch: app.fetch, port: 8202, hostname: "127.0.0.1" });
await new Promise((resolve) => server.once("listening", resolve));
const base = "http://127.0.0.1:8202";

afterAll(() => server.close());

const ID = expect.stringMatching(/^[0-9A-Z]{26}$/);

test("a route's trace is named by its route, its handler a span, its query under it", async () => {
  const response = await fetch(`${base}/books/7?page=2`);
  const result = await traceOf(response);

  expect(await response.json()).toEqual({ id: "7" });

  expect({
    id: response.headers.get("tracepanel-id"),
    url: response.headers.get("tracepanel-url"),
    timing: response.headers.get("server-timing"),
  }).toEqual({
    id: ID,
    url: `http://127.0.0.1:9/#/t/${result.id}`,
    timing: expect.stringMatching(/^db;dur=\d+\.\d;desc="1 query", app;dur=.*, total;dur=/),
  });

  expect([result.name, result.status]).toEqual(["GET /books/:id", "ok"]);

  expect(result.attrs).toEqual({
    "code.view": "/books/:id",
    "http.request.header.host": "127.0.0.1:8202",
    "http.request.header.connection": "keep-alive",
    "http.request.header.accept": "*/*",
    "http.request.header.accept_language": "*",
    "http.request.header.sec_fetch_mode": "cors",
    "http.request.header.user_agent": "node",
    "http.request.header.accept_encoding": "gzip, deflate",
    "url.query": "page=2",
    "http.response.header.content_type": "application/json",
    "http.method": "GET",
    "http.path": "/books/7",
    "http.route": "/books/:id",
    "http.status_code": 200,
    "service.name": "shop",
    "service.role": "web",
    "telemetry.sdk.language": "nodejs",
    "process.runtime.name": "node",
    "process.runtime.version": process.versions.node,
    "tracepanel.framework": expect.stringMatching(/^Hono 4\.\d+\.\d+$/),
    "w3c.trace_id": expect.stringMatching(/^[0-9a-f]{32}$/),
  });

  expect(tree(result, "code.origin")).toEqual([
    {
      kind: "http",
      name: "GET /books/:id",
      children: [
        {
          kind: "view",
          name: "/books/:id",
          children: [
            {
              kind: "sql",
              name: "SELECT books",
              attrs: { "code.origin": `${line("app/books.ts", "find book")} in findBook` },
            },
          ],
        },
      ],
    },
  ]);
});

test("a sub-app's route is named with its base path", async () => {
  const result = await traceOf(await fetch(`${base}/api/books/7/reviews`));

  expect([result.name, result.attrs["http.route"], tree(result)]).toEqual([
    "GET /api/books/:id/reviews",
    "/api/books/:id/reviews",
    [
      {
        kind: "http",
        name: "GET /api/books/:id/reviews",
        children: [{ kind: "view", name: "/api/books/:id/reviews" }],
      },
    ],
  ]);
});

test("a page gets the script first in its head", async () => {
  const response = await fetch(`${base}/page`);
  const [before, script, after] = (await response.text()).split(/(<script .*?<\/script>)/);

  expect([before, script, after]).toEqual([
    "<!doctype html><html><head>",
    expect.stringMatching(SCRIPT),
    "<title>t</title></head><body>x</body></html>",
  ]);

  expect(script).toContain(" · Hono 4.");
});

test("a page streamed gets the script as its head passes", async () => {
  const response = await fetch(`${base}/streamed`);
  const [before, script, after] = (await response.text()).split(/(<script .*?<\/script>)/);

  expect([before, script, after]).toEqual([
    "<!doctype html><html><head>",
    expect.stringMatching(SCRIPT),
    "<title>t</title></head><body>x</body></html>",
  ]);
});

test("a JSON body is recorded as far as the handler read it, its secrets masked", async () => {
  const response = await fetch(`${base}/books`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Dune", password: "p" }),
  });
  const result = await traceOf(response);

  expect([await response.json(), result.attrs["http.request.body"]]).toEqual([
    { title: "Dune", password: "p" },
    '{"title":"Dune","password":"********"}',
  ]);
});

test("an error the handler throws is the request's, with its locals; Hono's answer has the badge's headers", async () => {
  const response = await fetch(`${base}/reserve/7`);
  const result = await traceOf(response);
  const view = result.spans.find((span) => span.kind === "view");

  expect([response.status, await response.text(), response.headers.get("tracepanel-id")]).toEqual([
    500,
    "Internal Server Error",
    result.id,
  ]);

  expect([result.name, result.status]).toEqual(["GET /reserve/:id", "error"]);

  expect(
    result.errors.map(({ frames, ...error }) => ({ ...error, frames: frames.filter((frame) => frame.in_app) })),
  ).toEqual([
    {
      span_id: view?.id,
      time: expect.any(Number),
      type: "Error",
      message: "no copy of book 7 left for Ann",
      handled: false,
      frames: [
        expect.objectContaining({ filename: "test/hono.test.ts", in_app: true }),
        {
          filename: "test/app/books.ts",
          module: "",
          function: "reserve",
          lineno: Number(line("app/books.ts", "out of stock").split(":")[1]),
          in_app: true,
          context_start: expect.any(Number),
          context: expect.arrayContaining(["  const stock = { id, left: 0 };"]),
          locals: { id: "'7'", customer: "{ name: 'Ann', email: 'ann@example.com' }", stock: "{ id: '7', left: 0 }" },
        },
      ],
      chain: [],
    },
  ]);
});

test("an HTTPException below 500 is an answer, not an error; a request no route matched is named by its path", async () => {
  const gone = await fetch(`${base}/gone`);
  const thrown = await traceOf(gone);
  const nowhere = await traceOf(await fetch(`${base}/nowhere`));

  expect([gone.status, thrown.name, thrown.status, thrown.errors]).toEqual([404, "GET /gone", "ok", []]);

  expect([nowhere.name, nowhere.attrs["http.route"], nowhere.attrs["http.status_code"], tree(nowhere)]).toEqual([
    "GET /nowhere",
    null,
    404,
    [{ kind: "http", name: "GET /nowhere" }],
  ]);
});

test("a form's POST is recorded as the handler read it, its secrets masked, its redirect named in the next page's cookie", async () => {
  const body = "email=ann%40example.com&password=hunter2";
  const response = await send(`${base}/login?next=%2Fhome&token=t0k`, "POST", FORM, body);
  const result = await traceOf(response);

  expect([response.status, response.headers["set-cookie"]]).toEqual([
    303,
    ["sessionid=s3cr3t", `tracepanel_redirect=01EARLIER%2C${result.id}; Max-Age=30; Path=/; SameSite=Lax`],
  ]);

  expect(result.attrs).toEqual({
    "code.view": "/login",
    "http.request.header.content_type": "application/x-www-form-urlencoded",
    "http.request.header.accept": "text/html",
    "http.request.header.sec_fetch_mode": "navigate",
    "http.request.header.host": "127.0.0.1:8202",
    "http.request.header.connection": "close",
    "http.request.header.content_length": String(body.length),
    "url.query": "next=/home&token=********",
    "http.request.cookie.theme": "dark",
    "http.request.cookie.sessionid": "********",
    "http.request.cookie.tracepanel_redirect": "01EARLIER",
    "http.request.body": "email=ann@example.com&password=********",
    "http.response.header.set_cookie": "********",
    "http.response.header.location": "/home",
    "http.method": "POST",
    "http.path": "/login",
    "http.route": "/login",
    "http.status_code": 303,
    "service.name": "shop",
    "service.role": "web",
    "telemetry.sdk.language": "nodejs",
    "process.runtime.name": "node",
    "process.runtime.version": process.versions.node,
    "tracepanel.framework": expect.stringMatching(/^Hono 4\.\d+\.\d+$/),
    "w3c.trace_id": expect.stringMatching(/^[0-9a-f]{32}$/),
  });
});
