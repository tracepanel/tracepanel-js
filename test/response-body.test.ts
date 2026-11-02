// A response's body in its trace, on each Node server as `--import @tracepanel/js/register` traces it: one sent whole
// is recorded (JSON with its secrets masked, text cut at the limit), with its size; a stream (Server-Sent Events) by
// its size only, going out piece by piece as it is written, never held; nothing with TRACEPANEL_CAPTURE_BODY=0.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { serve } from "@hono/node-server";
import Router from "@koa/router";
import express from "express";
import Fastify from "fastify";
import { createSchema, createYoga } from "graphql-yoga";
import { Hono } from "hono";
import Koa from "koa";
import { afterAll, describe, expect, test } from "vitest";
import { tracepanel as expressMiddlewareOf } from "../src/express.js";
import { tracepanel as fastifyPlugin } from "../src/fastify.js";
import { tracepanelApolloPlugin, tracepanelYogaPlugin } from "../src/graphql.js";
import { tracepanel as honoMiddleware } from "../src/hono.js";
import { tracepanel as koaMiddleware } from "../src/koa.js";
import type { Attrs, Trace } from "../src/model.js";
import { limitBodies, MAX_BODY } from "../src/request.js";
import { traceWhere } from "./traced.js";

const ACCOUNT = { id: "7", password: "hunter2", owner: { apiKey: "k1", name: "Ann" } };
const MASKED = '{"id":"7","password":"********","owner":{"apiKey":"********","name":"Ann"}}';
const LARGE = "x".repeat(MAX_BODY + 100);
const EVENTS = ["data: 1\n\n", "data: 2\n\n"];
// A page: the widget's script goes into it on its way out.
const PAGE = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";
const PAGE_PIECES = ["<!doctype html><html><he", "ad><title>t</title></head>", "<body>x</body></html>"];

// A stream's second event waits here until the client has read the first.
let release: () => void = () => {};
function firstRead(): Promise<void> {
  return new Promise((resolve) => (release = resolve));
}

async function listening(server: Server): Promise<string> {
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Node's own server.
const node = createServer(async (req, res) => {
  const path = req.url ?? "/";
  if (path.endsWith("/json")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ACCOUNT));
  } else if (path.endsWith("/large")) {
    res.setHeader("Content-Type", "text/plain");
    res.end(LARGE);
  } else if (path.endsWith("/page")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(PAGE);
  } else if (path.endsWith("/streamed-page")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    for (const piece of PAGE_PIECES) res.write(piece);
    res.end();
  } else {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(EVENTS[0]);
    await firstRead();
    res.end(EVENTS[1]);
  }
}).listen(0, "127.0.0.1");

const expressApp = express();
expressApp.use(expressMiddlewareOf());
expressApp.get("/:run/json", (_req, res) => {
  res.json(ACCOUNT);
});
expressApp.get("/:run/large", (_req, res) => {
  res.type("text/plain").send(LARGE);
});
expressApp.get("/:run/page", (_req, res) => {
  res.type("html").send(PAGE);
});
expressApp.get("/:run/streamed-page", (_req, res) => {
  res.type("html");
  for (const piece of PAGE_PIECES) res.write(piece);
  res.end();
});
expressApp.get("/:run/events", async (_req, res) => {
  res.type("text/event-stream");
  res.write(EVENTS[0]);
  await firstRead();
  res.end(EVENTS[1]);
});
const expressServer = expressApp.listen(0, "127.0.0.1");

const fastify = Fastify();
await fastify.register(fastifyPlugin());
fastify.get("/:run/json", async () => ACCOUNT);
fastify.get("/:run/large", async (_request, reply) => reply.type("text/plain").send(LARGE));
fastify.get("/:run/page", async (_request, reply) => reply.type("text/html").send(PAGE));
fastify.get("/:run/streamed-page", async (_request, reply) => reply.type("text/html").send(Readable.from(PAGE_PIECES)));
fastify.get("/:run/events", (_request, reply) => {
  const stream = new PassThrough();
  stream.write(EVENTS[0]);
  void firstRead().then(() => stream.end(EVENTS[1]));
  return reply.type("text/event-stream").send(stream);
});
await fastify.listen({ port: 0, host: "127.0.0.1" });

const koa = new Koa();
const router = new Router();
router.get("/:run/json", (ctx) => {
  ctx.body = ACCOUNT;
});
router.get("/:run/large", (ctx) => {
  ctx.type = "text/plain";
  ctx.body = LARGE;
});
router.get("/:run/page", (ctx) => {
  ctx.type = "html";
  ctx.body = PAGE;
});
router.get("/:run/streamed-page", (ctx) => {
  ctx.type = "html";
  ctx.body = Readable.from(PAGE_PIECES);
});
router.get("/:run/events", (ctx) => {
  const stream = new PassThrough();
  stream.write(EVENTS[0]);
  void firstRead().then(() => stream.end(EVENTS[1]));
  ctx.type = "text/event-stream";
  ctx.body = stream;
});
koa.use(koaMiddleware());
koa.use(router.routes());
const koaServer = koa.listen(0, "127.0.0.1");

const hono = new Hono();
hono.use(honoMiddleware());
hono.get("/:run/json", (c) => c.json(ACCOUNT));
hono.get("/:run/large", (c) => c.text(LARGE));
hono.get("/:run/page", (c) => c.html(PAGE));
hono.get("/:run/streamed-page", (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of PAGE_PIECES) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return c.body(stream, 200, { "Content-Type": "text/html; charset=utf-8" });
});
hono.get("/:run/events", (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(EVENTS[0]));
      await firstRead();
      controller.enqueue(encoder.encode(EVENTS[1]));
      controller.close();
    },
  });
  return c.body(stream, 200, { "Content-Type": "text/event-stream" });
});
const honoServer = serve({ fetch: hono.fetch, port: 0, hostname: "127.0.0.1" }) as Server;

const servers = {
  "Node's http server": await listening(node),
  Express: await listening(expressServer),
  Fastify: `http://127.0.0.1:${(fastify.server.address() as AddressInfo).port}`,
  Koa: await listening(koaServer),
  "Hono (@hono/node-server)": await listening(honoServer),
};

// GraphQL: Yoga on Node's server, its subscriptions as Server-Sent Events; Apollo Server on Express.
const typeDefs = /* GraphQL */ `
  type Owner {
    apiKey: String!
    name: String!
  }
  type Account {
    id: ID!
    password: String!
    owner: Owner!
  }
  type Query {
    account: Account!
    essay: String!
  }
  type Subscription {
    ticks: Int!
  }
`;
const resolvers = {
  Query: { account: () => ACCOUNT, essay: () => LARGE },
  Subscription: {
    ticks: {
      subscribe: async function* () {
        yield { ticks: 1 };
        await firstRead();
        yield { ticks: 2 };
      },
    },
  },
};
const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  plugins: [tracepanelYogaPlugin()],
  logging: false,
});
const yogaServer = createServer(yoga).listen(0, "127.0.0.1");
const yogaUrl = `${await listening(yogaServer)}/graphql`;

const apollo = new ApolloServer({
  typeDefs: typeDefs.replace(/type Subscription \{[^}]*\}/, ""),
  resolvers: { Query: resolvers.Query },
  plugins: [tracepanelApolloPlugin()],
});
await apollo.start();
const apolloApp = express();
apolloApp.use(expressMiddlewareOf());
apolloApp.use("/graphql", express.json(), expressMiddleware(apollo));
const apolloServer = apolloApp.listen(0, "127.0.0.1");
const apolloUrl = `${await listening(apolloServer)}/graphql`;

afterAll(async () => {
  for (const server of [node, expressServer, koaServer, honoServer, yogaServer, apolloServer]) server.close();
  await fastify.close();
  await apollo.stop();
});

/** The trace's response body attributes. */
function responseBody(trace: Trace): Attrs {
  return Object.fromEntries(Object.entries(trace.attrs).filter(([key]) => key.startsWith("http.response.body")));
}

let runs = 0;

/** A request to a path of its own (`/<run>/<what>`), and its trace once its response was read. */
async function traced(base: string, what: string): Promise<{ response: Response; trace: () => Promise<Trace> }> {
  runs += 1;
  const path = `/run${runs}/${what}`;
  const response = await fetch(`${base}${path}`);
  return { response, trace: () => traceWhere((trace) => trace.attrs["http.path"] === path) };
}

/** The pieces of a body as the client reads them: the stream's second event only once it read the first. */
async function readEvents(response: Response): Promise<string[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const read = [decoder.decode(first.value)];
  release();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return read;
    read.push(decoder.decode(value));
  }
}

/** With TRACEPANEL_CAPTURE_BODY=0, for the time of `run`. */
async function bodiesOff<T>(run: () => Promise<T>): Promise<T> {
  limitBodies({ captureBody: false, maxBodyKb: 64 });
  try {
    return await run();
  } finally {
    limitBodies({ captureBody: true, maxBodyKb: 64 });
  }
}

describe.each(Object.entries(servers))("%s", (_name, base) => {
  test("a page is recorded by its own size, as the app sent it: the widget's script put in is not counted", async () => {
    const { response, trace } = await traced(base, "page");
    const body = await response.text();

    expect(body.replace(/<script .*?<\/script>/, "")).toBe(PAGE);

    expect(responseBody(await trace())).toEqual({ "http.response.body.size": PAGE.length });
  });

  test("a page streamed is recorded by its own size too, the script put in as it passed not counted", async () => {
    const { response, trace } = await traced(base, "streamed-page");
    const body = await response.text();

    expect(body.replace(/<script .*?<\/script>/, "")).toBe(PAGE);

    expect(responseBody(await trace())).toEqual({ "http.response.body.size": PAGE.length });
  });

  test("JSON sent whole is recorded with its size, its secrets masked", async () => {
    const { response, trace } = await traced(base, "json");

    expect(await response.json()).toEqual(ACCOUNT);

    expect(responseBody(await trace())).toEqual({
      "http.response.body": MASKED,
      "http.response.body.size": JSON.stringify(ACCOUNT).length,
    });
  });

  test("a body past the limit is cut there, and says so; its size is all of it", async () => {
    const { response, trace } = await traced(base, "large");

    expect(await response.text()).toBe(LARGE);

    expect(responseBody(await trace())).toEqual({
      "http.response.body": "x".repeat(MAX_BODY),
      "http.response.body.truncated": true,
      "http.response.body.size": LARGE.length,
    });
  });

  test("a stream goes out as it is written, never held; its size only is recorded", async () => {
    const { response, trace } = await traced(base, "events");

    expect(await readEvents(response).then((read) => read.join(""))).toBe(EVENTS.join(""));

    expect(responseBody(await trace())).toEqual({ "http.response.body.size": EVENTS.join("").length });
  });

  test("with bodies off, none is recorded", async () => {
    const { response, trace } = await bodiesOff(() => traced(base, "json"));

    expect(await response.json()).toEqual(ACCOUNT);

    expect(responseBody(await trace())).toEqual({});
  });
});

let operations = 0;

/** The trace of a GraphQL operation named for this run, and its answer. */
async function graphql(
  url: string,
  query: (name: string) => string,
  accept = "application/json",
): Promise<{ response: Response; trace: Trace }> {
  operations += 1;
  const name = `Run${operations}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify({ query: query(name) }),
  });
  const body = accept === "text/event-stream" ? (await readEvents(response)).join("") : await response.text();
  const trace = await traceWhere((trace) => trace.attrs["graphql.operation.name"] === name);
  return { response: new Response(body), trace };
}

describe.each([
  ["GraphQL Yoga", yogaUrl],
  ["Apollo Server", apolloUrl],
])("%s", (_name, url) => {
  test("an answer is recorded with its size, its secrets masked", async () => {
    const { response, trace } = await graphql(
      url,
      (name) => `query ${name} { account { id password owner { apiKey name } } }`,
    );
    const sent = await response.text();

    expect(JSON.parse(sent)).toEqual({ data: { account: ACCOUNT } });

    expect(responseBody(trace)).toEqual({
      "http.response.body": `{"data":{"account":${MASKED}}}`,
      "http.response.body.size": Buffer.byteLength(sent),
    });
  });

  test("an answer past the limit is cut there, and says so", async () => {
    const { response, trace } = await graphql(url, (name) => `query ${name} { essay }`);
    const sent = await response.text();

    expect(JSON.parse(sent)).toEqual({ data: { essay: LARGE } });

    expect(responseBody(trace)).toEqual({
      "http.response.body": `{"data":{"essay":"${LARGE}"}}`.slice(0, MAX_BODY),
      "http.response.body.truncated": true,
      "http.response.body.size": Buffer.byteLength(sent),
    });
  });

  test("with bodies off, none is recorded", async () => {
    const { trace } = await bodiesOff(() => graphql(url, (name) => `query ${name} { account { id } }`));

    expect(responseBody(trace)).toEqual({});
  });
});

test("GraphQL Yoga's subscription over Server-Sent Events goes out as it is made; its size only is recorded", async () => {
  const { response, trace } = await graphql(yogaUrl, (name) => `subscription ${name} { ticks }`, "text/event-stream");
  const sent = await response.text();

  expect(sent).toContain('"ticks":1');
  expect(sent).toContain('"ticks":2');

  expect(responseBody(trace)).toEqual({ "http.response.body.size": Buffer.byteLength(sent) });
});
