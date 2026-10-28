// `app.use(tracepanel())` on a real Koa server with @koa/router: each route's handler is a span named by its route,
// and so is the trace, routes added after the router was mounted too. A page gets the widget's script, whole or
// streamed; what the request carried goes into its trace; an error answered with a 500 is the request's, with its
// locals, and its answer has the badge's headers.
import { Readable } from "node:stream";
import Router from "@koa/router";
import Koa from "koa";
import { afterAll, expect, test } from "vitest";
import { tracepanel } from "../src/koa.js";
import { findBook, reserve } from "./app/books.js";
import { FORM, line, SCRIPT, send, traceOf, tree } from "./traced.js";

const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

const app = new Koa();
// Koa prints the errors it answers: the test's are on purpose.
app.silent = true;
app.use(tracepanel());
// What a body parser (@koa/bodyparser, koa-body) does: the form's fields on ctx.request.body.
app.use(async (ctx, next) => {
  if (ctx.is("urlencoded")) {
    let text = "";
    for await (const chunk of ctx.req) text += chunk;
    (ctx.request as typeof ctx.request & { body: unknown }).body = Object.fromEntries(new URLSearchParams(text));
  }
  await next();
});
const router = new Router();
router.get("/books/:id", (ctx) => {
  ctx.body = findBook(ctx.params.id ?? "");
});
router.get("/page", (ctx) => {
  ctx.type = "html";
  ctx.body = PAGE;
});
router.get("/streamed", (ctx) => {
  ctx.type = "html";
  ctx.body = Readable.from(["<!doctype html><html><he", "ad><title>t</title></head>", "<body>x</body></html>"]);
});
router.get("/reserve/:id", (ctx) => reserve(ctx.params.id ?? "", { name: "Ann", email: "ann@example.com" }));
router.get("/gone", (ctx) => ctx.throw(404, "no such book"));
router.post("/login", (ctx) => {
  ctx.append("Set-Cookie", "sessionid=s3cr3t");
  ctx.status = 303;
  ctx.redirect("/home");
});
const api = new Router({ prefix: "/api/books" });
api.get("/:id/reviews", (ctx) => {
  ctx.body = [];
});
router.use(api.routes());
app.use(router.routes());
// Added once the router is mounted: traced all the same.
router.get("/later", (ctx) => {
  ctx.body = "later";
});
const server = app.listen(8201, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = "http://127.0.0.1:8201";

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
    "http.request.header.host": "127.0.0.1:8201",
    "http.request.header.connection": "keep-alive",
    "http.request.header.accept": "*/*",
    "http.request.header.accept_language": "*",
    "http.request.header.sec_fetch_mode": "cors",
    "http.request.header.user_agent": "node",
    "http.request.header.accept_encoding": "gzip, deflate",
    "url.query": "page=2",
    "http.response.header.content_type": "application/json; charset=utf-8",
    "http.method": "GET",
    "http.path": "/books/7",
    "http.route": "/books/:id",
    "http.status_code": 200,
    "service.name": "shop",
    "service.role": "web",
    "telemetry.sdk.language": "nodejs",
    "process.runtime.name": "node",
    "process.runtime.version": process.versions.node,
    "tracepanel.framework": expect.stringMatching(/^Koa 3\.\d+\.\d+$/),
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

test("a nested router's route is named with its prefix, and a route added after mounting is traced", async () => {
  const nested = await traceOf(await fetch(`${base}/api/books/7/reviews`));
  const later = await traceOf(await fetch(`${base}/later`));

  expect([nested.name, nested.attrs["http.route"], tree(nested)]).toEqual([
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

  expect([later.name, tree(later)]).toEqual([
    "GET /later",
    [{ kind: "http", name: "GET /later", children: [{ kind: "view", name: "/later" }] }],
  ]);
});

test("a page gets the script first in its head, and its new size", async () => {
  const response = await fetch(`${base}/page`);
  const body = await response.text();
  const [before, script, after] = body.split(/(<script .*?<\/script>)/);

  expect([before, script, after]).toEqual([
    "<!doctype html><html><head>",
    expect.stringMatching(SCRIPT),
    "<title>t</title></head><body>x</body></html>",
  ]);

  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));

  expect(script).toContain(" · Koa 3.");
});

test("a page streamed gets the script as its head passes", async () => {
  const response = await fetch(`${base}/streamed`);
  const [before, script, after] = (await response.text()).split(/(<script .*?<\/script>)/);

  expect([before, script, after]).toEqual([
    "<!doctype html><html><head>",
    expect.stringMatching(SCRIPT),
    "<title>t</title></head><body>x</body></html>",
  ]);

  expect([response.headers.get("content-length"), response.headers.get("transfer-encoding")]).toEqual([
    null,
    "chunked",
  ]);
});

test("an error the handler throws is the request's, with its locals, and Koa's answer has the badge's headers", async () => {
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
        expect.objectContaining({ filename: "test/koa.test.ts", in_app: true }),
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

test("ctx.throw(404) is an answer, not an error; a request no route matched is named by its path", async () => {
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

test("a form's POST is recorded as the body parser read it, its secrets masked, its redirect named in the next page's cookie", async () => {
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
    "http.request.header.host": "127.0.0.1:8201",
    "http.request.header.connection": "close",
    "http.request.header.content_length": String(body.length),
    "url.query": "next=/home&token=********",
    "http.request.cookie.theme": "dark",
    "http.request.cookie.sessionid": "********",
    "http.request.cookie.tracepanel_redirect": "01EARLIER",
    "http.request.body": "email=ann@example.com&password=********",
    "http.response.header.set_cookie": "********",
    "http.response.header.location": "/home",
    "http.response.header.content_type": "text/html; charset=utf-8",
    "http.response.header.content_length": expect.any(String),
    "http.method": "POST",
    "http.path": "/login",
    "http.route": "/login",
    "http.status_code": 303,
    "service.name": "shop",
    "service.role": "web",
    "telemetry.sdk.language": "nodejs",
    "process.runtime.name": "node",
    "process.runtime.version": process.versions.node,
    "tracepanel.framework": expect.stringMatching(/^Koa 3\.\d+\.\d+$/),
    "w3c.trace_id": expect.stringMatching(/^[0-9a-f]{32}$/),
  });
});
