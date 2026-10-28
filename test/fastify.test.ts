// `await app.register(tracepanel())` on a real Fastify server: each route's handler is a span named by its route, with
// the app's line that added it; the trace is named by the route. A page gets the widget's script, whole or streamed;
// what the request carried goes into its trace; an error answered with a 500 is the request's, with its locals.
import { Readable } from "node:stream";
import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { afterAll, expect, test } from "vitest";
import { tracepanel } from "../src/fastify.js";
import { findBook, reserve } from "./app/books.js";
import { FORM, line, SCRIPT, send, traceOf, tree } from "./traced.js";

const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

const app = Fastify();
await app.register(tracepanel());
await app.register(formbody);
app.get("/books/:id", async (request) => findBook((request.params as { id: string }).id)); // books route
await app.register(
  async (books) => {
    books.get("/:id/reviews", async () => []);
  },
  { prefix: "/api/books" },
);
app.get("/page", async (_request, reply) => reply.type("text/html").send(PAGE));
app.get("/streamed", async (_request, reply) =>
  reply
    .type("text/html")
    .send(Readable.from(["<!doctype html><html><he", "ad><title>t</title></head>", "<body>x</body></html>"])),
);
app.get("/reserve/:id", async (request) =>
  reserve((request.params as { id: string }).id, { name: "Ann", email: "ann@example.com" }),
);
app.get("/missing", async (_request, reply) => reply.code(404).send({ error: "no such book" }));
app.get("/thrown-404", async () => {
  throw Object.assign(new Error("no such book"), { statusCode: 404 });
});
app.post("/login", async (_request, reply) => reply.header("set-cookie", "sessionid=s3cr3t").redirect("/home", 303));
const base = await app.listen({ port: 8200, host: "127.0.0.1" });

afterAll(() => app.close());

/** The badge's headers a response carries. */
function badgeHeaders(response: Response): Record<string, string | null> {
  const names = ["tracepanel-id", "tracepanel-url", "server-timing", "content-length"];
  return Object.fromEntries(names.map((name) => [name, response.headers.get(name)]));
}

const ID = expect.stringMatching(/^[0-9A-Z]{26}$/);

test("a route's trace is named by its route, its handler a span with the line that added it, its query under it", async () => {
  const response = await fetch(`${base}/books/7?page=2`);
  const result = await traceOf(response);

  expect(await response.json()).toEqual({ id: "7" });

  expect(badgeHeaders(response)).toEqual({
    "tracepanel-id": ID,
    "tracepanel-url": `http://127.0.0.1:9/#/t/${response.headers.get("tracepanel-id")}`,
    "server-timing": expect.stringMatching(/^db;dur=\d+\.\d;desc="1 query", app;dur=.*, total;dur=/),
    "content-length": "10",
  });

  expect([result.name, result.status]).toEqual(["GET /books/:id", "ok"]);

  expect(result.attrs).toEqual({
    "code.view": "/books/:id",
    "http.request.header.host": "127.0.0.1:8200",
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
    "tracepanel.framework": expect.stringMatching(/^Fastify 5\.\d+\.\d+$/),
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
          attrs: { "code.origin": `${line("fastify.test.ts", "books route")} in <anonymous>` },
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

test("a route a plugin adds under its prefix is named with it", async () => {
  const result = await traceOf(await fetch(`${base}/api/books/7/reviews`));

  expect([result.name, result.attrs["http.route"], result.attrs["code.view"]]).toEqual([
    "GET /api/books/:id/reviews",
    "/api/books/:id/reviews",
    "/api/books/:id/reviews",
  ]);
});

test("a page sent whole gets the script first in its head, and its new size", async () => {
  const response = await fetch(`${base}/page`);
  const body = await response.text();
  const [before, script, after] = body.split(/(<script .*?<\/script>)/);

  expect([before, script, after]).toEqual([
    "<!doctype html><html><head>",
    expect.stringMatching(SCRIPT),
    "<title>t</title></head><body>x</body></html>",
  ]);

  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));

  expect(script).toContain('data-tracepanel-runtime="Node ');
  expect(script).toContain(" · Fastify 5.");
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

test("an error the handler throws is the request's, on its handler's span, with the app's frames and their locals", async () => {
  const response = await fetch(`${base}/reserve/7`);
  const result = await traceOf(response);
  const view = result.spans.find((span) => span.kind === "view");

  expect([response.status, response.headers.get("tracepanel-id")]).toEqual([500, ID]);

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
        expect.objectContaining({ filename: "test/fastify.test.ts", function: "<anonymous>", in_app: true }),
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

test("an answer below 500, sent or thrown, is no error", async () => {
  const sent = await traceOf(await fetch(`${base}/missing`));
  const thrown = await traceOf(await fetch(`${base}/thrown-404`));

  expect([sent.name, sent.status, sent.errors]).toEqual(["GET /missing", "ok", []]);

  expect([thrown.name, thrown.status, thrown.errors, thrown.attrs["http.status_code"]]).toEqual([
    "GET /thrown-404",
    "ok",
    [],
    404,
  ]);
});

test("a request no route matched is named by its path, without a handler", async () => {
  const response = await fetch(`${base}/nowhere`);
  const result = await traceOf(response);

  expect([response.status, result.name, result.attrs["http.route"], tree(result)]).toEqual([
    404,
    "GET /nowhere",
    null,
    [{ kind: "http", name: "GET /nowhere" }],
  ]);
});

test("a form's POST is recorded as Fastify parsed it, its secrets masked, its redirect named in the next page's cookie", async () => {
  const body = "email=ann%40example.com&password=hunter2";
  const response = await send(`${base}/login?next=%2Fhome&token=t0k`, "POST", FORM, body);
  const result = await traceOf(response);

  expect([response.status, response.headers["set-cookie"]]).toEqual([
    303,
    [
      "sessionid=s3cr3t",
      `tracepanel_redirect=01EARLIER%2C${response.headers["tracepanel-id"]}; Max-Age=30; Path=/; SameSite=Lax`,
    ],
  ]);

  expect(result.attrs).toEqual({
    "code.view": "/login",
    "http.request.header.content_type": "application/x-www-form-urlencoded",
    "http.request.header.accept": "text/html",
    "http.request.header.sec_fetch_mode": "navigate",
    "http.request.header.host": "127.0.0.1:8200",
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
    "tracepanel.framework": expect.stringMatching(/^Fastify 5\.\d+\.\d+$/),
    "w3c.trace_id": expect.stringMatching(/^[0-9a-f]{32}$/),
  });
});
