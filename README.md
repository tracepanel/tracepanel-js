# Tracepanel for Node.js and Bun

[![CI](https://github.com/tracepanel/tracepanel-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tracepanel/tracepanel-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tracepanel/js)](https://www.npmjs.com/package/@tracepanel/js)
[![Node.js](https://img.shields.io/node/v/@tracepanel/js)](https://www.npmjs.com/package/@tracepanel/js)

**See what your Node.js or Bun app is really doing.** Tracepanel records each
request and background job of your app with its SQL queries, Redis and
MongoDB commands, outgoing HTTP calls, logs and errors. It points out N+1
queries and calls, duplicates, slow SQL and slow HTTP calls, and names the
line of code to fix. You read it in a panel on your pages and in a console.

It runs while you develop, and everything stays on your machine.

[![A 40-second demo of a Next.js store: Swagger UI's Try it out on an endpoint, and the panel docked under it with the request's call tree, an N+1 with its query plan and line, a BullMQ job, the CPU profile, and the same call after the fix](https://raw.githubusercontent.com/tracepanel/tracepanel-js/main/assets/demo-video.jpg)](https://tracepanel.dev/video/demo-js.mp4)

▶ [Watch the 40-second demo](https://tracepanel.dev/video/demo-js.mp4)

## Works with

| | Supported |
| --- | --- |
| **Runtimes** | Node.js 20.19 and later, tested in CI on 20.19, 22, 24 and 26. Bun. |
| **Frameworks** | Express 4.18 and later, Fastify 5, Koa 3 with `@koa/router`, Hono 4.8 and later on Node and on Bun, NestJS on Express, Next.js in its Node.js runtime, Nuxt, and `Bun.serve`. On Bun also any fetch handler, such as Elysia's. Any other server on Node's `node:http` at the request level. |
| **GraphQL** | GraphQL Yoga and Apollo Server, through their plugins: each request named after its operation, the app's resolvers as steps with their calls under them, resolver errors behind HTTP 200. |
| **Databases** | `pg` and `mysql2`, and so Drizzle, Knex, Sequelize, TypeORM and Prisma's driver adapters, with Prisma's operations as steps. SQLite through `better-sqlite3`, `node:sqlite` and `libsql`. Transactions and their savepoints. EXPLAIN on PostgreSQL, MySQL and SQLite. |
| **Redis and MongoDB** | `ioredis` and `redis`, and the MongoDB driver, with their own N+1 and duplicates. |
| **HTTP clients** | `fetch()`, and `node:http` clients such as axios, on Node and on Bun. |
| **AWS** | The AWS SDK's v3 clients (`@aws-sdk/client-*`): S3 as storage calls, DynamoDB commands with their N+1 and duplicates, SQS and SNS messages, and every other service's calls, with their errors and retries. |
| **LLMs** | OpenAI's and Anthropic's SDKs, and the AI SDK's OpenAI and Anthropic providers: each call's model, tokens, cost, time to the first chunk of a stream, and errors. |
| **Background jobs** | BullMQ: each job a worker runs is a task, each job the app adds a step, and the jobs in flight are listed live. |
| **Logs** | `console`, pino, winston and Nest's `Logger`, each line on the request or job that wrote it. |
| **Errors** | Thrown in a handler, with your frames, their source and, on Node, their local variables. |
| **Profiling** | Where a request's CPU time goes, and on request its memory and garbage collections, on Node. |
| **Tests** | Vitest 4.1 and later: a test fails when it makes an N+1 or duplicate queries. |
| **Browser** | The badge and its panel on server-rendered pages, in Next.js through `<Tracepanel />` and in an SPA through the Vite plugin. The pages' views and clicks with their `fetch()` calls, linked to the API's traces. |

The settings and what each integration records are in the
[JavaScript docs](https://tracepanel.dev/docs/javascript).

## Install

```bash
npm install @tracepanel/js
```

It brings the agent for your platform, `@tracepanel/agent`, which keeps the
traces and serves the console.

## Setup

Tracepanel is on unless `NODE_ENV` is `production`. `TRACEPANEL_ENABLED=0`
turns it off and `TRACEPANEL_ENABLED=1` turns it on. It starts its agent on
the first request. The agent keeps the traces in `.tracepanel/` in your
project and serves the console. Open a page and click the badge in the
corner.

### Express

Start the app with Tracepanel loaded before it, so OpenTelemetry can
instrument its HTTP server, Express and its database driver, and add the
middleware. It puts the badge on HTML pages and gives every response its
trace id:

```bash
node --import @tracepanel/js/register server.js
```

```js
import express from "express";
import { tracepanel } from "@tracepanel/js/express";

const app = express();
app.use(tracepanel());
```

The flag is how Tracepanel gets in before the app. An ES module's imports
all load before any of its code runs, so `import "@tracepanel/js/register"` at
the top of `server.js` comes too late for Express and the database driver.
Without the flag, either let the CLI add it:

```json
{ "scripts": { "dev": "tracepanel run node server.js" } }
```

or start from a file that loads Tracepanel, then the app:

```js
// main.js, run with `node main.js`
import "@tracepanel/js/register";
await import("./server.js");
```

The agent starts by itself either way, on the app's first request.

### Fastify

Load Tracepanel before the app as for Express, and register the plugin
before the routes, so it sees each one as it is added:

```bash
node --import @tracepanel/js/register server.js
```

```js
import Fastify from "fastify";
import { tracepanel } from "@tracepanel/js/fastify";

const app = Fastify();
await app.register(tracepanel());
app.get("/books/:id", async (request) => findBook(request.params.id));
```

Each request is named by its route (`GET /books/:id`), and its handler is a
step of its own, with the line that added the route. HTML pages get the
badge, sent whole or streamed. An error Fastify answers with a 500 is the
request's error, with its local variables; one it answers below 500, such
as a validation error or a `statusCode: 404`, is the response.

### Koa

Load Tracepanel before the app as for Express, and add the middleware first:

```bash
node --import @tracepanel/js/register server.js
```

```js
import Koa from "koa";
import Router from "@koa/router";
import { tracepanel } from "@tracepanel/js/koa";

const app = new Koa();
app.use(tracepanel());
const router = new Router();
router.get("/books/:id", async (ctx) => {
  ctx.body = await findBook(ctx.params.id);
});
app.use(router.routes());
```

Each `@koa/router` route's handler is a step named by its route, and so is
the request, nested routers' prefixes included. The badge goes on HTML pages,
and on the answer Koa gives an error. `ctx.throw(404)` is the response, not
an error.

### Hono

On Node, serve the app with `@hono/node-server`, load Tracepanel before it,
and add the middleware first:

```bash
node --import @tracepanel/js/register server.js
```

```js
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { tracepanel } from "@tracepanel/js/hono";

const app = new Hono();
app.use(tracepanel());
app.get("/books/:id", async (c) => c.json(await findBook(c.req.param("id"))));
serve({ fetch: app.fetch });
```

Each request is named by its route, a sub-app's base path included, and its
handler is a step of its own. HTML pages get the badge, and the request's
body goes into its trace as far as the handler read it. An `HTTPException`
below 500, or what `app.onError` answers below 500, is the response.

On Bun, add the same middleware and serve the app with `serve()` from
`@tracepanel/js/bun` (see Bun below), which puts the badge on the response.

### NestJS

Nest runs on Express: load Tracepanel the same way and add the same
middleware in `main.ts`. Each request's handler is its controller method,
such as `BooksController.list`, and the Nest `Logger`'s records go to the
request's trace. An `HttpException` that answers below 500 is the response,
not an error.

```bash
node --import @tracepanel/js/register dist/main.js
```

```ts
import { NestFactory } from "@nestjs/core";
import { tracepanel } from "@tracepanel/js/express";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);
app.use(tracepanel());
await app.listen(3000);
```

### GraphQL

Add the plugin of your GraphQL server; load Tracepanel and its framework's
middleware as above. GraphQL Yoga, on Express or any other server:

```js
import { createYoga } from "graphql-yoga";
import { tracepanelYogaPlugin } from "@tracepanel/js/graphql";

const yoga = createYoga({ schema, plugins: [tracepanelYogaPlugin()] });
app.use(yoga.graphqlEndpoint, yoga);
```

Apollo Server:

```js
import { ApolloServer } from "@apollo/server";
import { tracepanelApolloPlugin } from "@tracepanel/js/graphql";

const server = new ApolloServer({ typeDefs, resolvers, plugins: [tracepanelApolloPlugin()] });
```

Each request is named after its operation, such as `GraphQL query Books`, so
traffic groups by operation rather than `POST /graphql`, and the console's
GraphQL page lists them. The operation is a step with its parse and validate
phases, and each of your resolvers is a step, such as `Book.author`, with
the queries and calls it makes under it: an N+1 shows which field runs it.
Fields without a resolver of their own are left out. An exception a resolver
throws is the request's error though the client gets it with a 200; a
`GraphQLError` you answer with, and a client's syntax or validation error,
are not. The variables are in the request's body, their secrets masked.

### Next.js

Next.js starts its own server: Tracepanel goes in from the instrumentation
hook, and Next.js makes each request's root span itself. Keep the package out
of the bundles, and put the badge in the root layout:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("@tracepanel/js/next")).register();
}
```

```ts
// next.config.ts
const config = { serverExternalPackages: ["@tracepanel/js"] };
export default config;
```

```tsx
// app/layout.tsx
import { Tracepanel } from "@tracepanel/js/next/widget";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <Tracepanel />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

A request's handler is its page or route handler, named by its route
(`/api/books/[id]`).

In development the app's server also serves the console at `/__tracepanel__/`
on its own origin, for this machine only, and the badge loads from there.
`<Tracepanel />` records the pages in the browser too, as the Vite plugin
does (see below). It takes the same options:

```tsx
<Tracepanel browser={{ service: "shop-web", propagateTo: ["http://127.0.0.1:8000"] }} />
```

The recording is inline in `<head>`, so it wraps `fetch` before the app's
scripts run, even a client that keeps `fetch` from when it is made
(`openapi-fetch`). `browser={false}` leaves it out.

### Nuxt

Add the module and start `nuxt dev` with Tracepanel loaded, so it hooks the
database driver as Nitro loads it:

```ts
// nuxt.config.ts
export default defineNuxtConfig({ modules: ["@tracepanel/js/nuxt"] });
```

```bash
NODE_OPTIONS=--import=@tracepanel/js/register nuxt dev
```

The module names each request by its route (`/api/books/:id`), puts the
badge on server-rendered pages, and records the errors h3 answers with a 500.

### Bun

`serve()` is `Bun.serve` with each route traced under its pattern, and
`withTracepanel()` wraps any fetch handler, such as Elysia's `handle`. A Hono
app is `serve({ fetch: app.fetch })`, with its `tracepanel()` middleware (see
Hono above) naming its routes:

```bash
bun --preload @tracepanel/js/register server.ts
```

```ts
import { serve } from "@tracepanel/js/bun";

serve({
  routes: {
    "/api/books/:id": async (req) => Response.json(await findBook(req.params.id)),
  },
});
```

### An SPA on Vite

A single-page app on Vite's dev server gets the badge from the plugin, whatever
serves its API: an app Tracepanel traces, in Node or in Python. It puts the
widget into `index.html` and serves the backend's console on Vite's origin,
from the backend project's `.tracepanel/`:

```ts
// vite.config.ts
import { tracepanel } from "@tracepanel/js/vite";

export default { plugins: [tracepanel({ dir: "../backend" })] };
```

When the page loads before the API's first request, the plugin starts the
backend's agent itself, as the SDK would. The console answers this machine
only, even with Vite on the network (`vite --host`): its traces and what it
lets a local caller do, such as switching the user, are the developer's.

An API on another origin exposes the trace's headers to the page on its CORS
responses, so the badge lists each call the app makes. A backend that serves
its own console (Django, FastAPI) is named with `console`:

```ts
tracepanel({ console: "http://localhost:8000/__tracepanel__/" });
```

The plugin also records the pages in the browser. Each view (the page's load,
or a route change) is a trace, and so is each action on it: a click or a
submit that called the API, named after the control (`click "Save"`), or
background calls nobody started. Each has its calls, its errors and its
console, with the line that logged each record, and lasts until its last
call answered. The console lists them in Pages, the page's view first and
its actions under it, and the badge's panel lists each action over the
requests it made.

A call to the page's own origin carries a W3C `traceparent`, so the console
links it to the API's trace. While the panel's Profile toggle is on, the
same calls carry `X-Tracepanel-Profile` (`1`, or `memory`), so an API on
another origin, which never gets the toggle's cookie, profiles the request
too, and so does each app it calls in turn. `propagateTo` names other
origins, whose CORS must allow both headers (`cors()` and
`allow_headers=["*"]` do):

```ts
tracepanel({ dir: "../backend", browser: { service: "shop-web", propagateTo: ["http://127.0.0.1:8000"] } });
```

`browser: false` leaves the recording out. Vite's own client logs (its
connection, hot reload) stay out of the pages' traces.

Without Vite, call `record()` from `@tracepanel/js/browser` in the page, with the
console on the page's origin (`api`, `/__tracepanel__/` by default).
`ignoreSources` takes the path prefixes of scripts whose console isn't the
page's, such as a dev server's client.

## What it looks like

Each request shows its call tree, with the SQL queries, the calls and the
issues in it. Here a Next.js store on Postgres lists its products from
Swagger UI, and loads each product's category, brand and rating in a query of
its own:

![A Next.js app's Swagger UI with an endpoint run with Try it out and the start of its 200 response, and the panel docked under it with the same request's call tree and its three N+1 queries](https://raw.githubusercontent.com/tracepanel/tracepanel-js/main/assets/panel-call-tree.png)

The panel also lists what happened on the page: its view, each click, and the
requests it made with `fetch()`, here Swagger UI's Execute. Each issue names
the line that ran it and the fix:

![The same Swagger UI with the panel docked under it on that request's Issues tab: each N+1 with the line it comes from and the fix](https://raw.githubusercontent.com/tracepanel/tracepanel-js/main/assets/panel-issues.png)

## What it records

- HTTP requests, with the route and the handler that served them, and what
  each one carried: its headers, query and cookies, the body as far as the
  app read it, and the response's headers. Values under names such as
  `password`, `token`, `session` or `csrf` are masked, and they never leave
  your machine. A body is what the app read, up to 16 KB: in Express and
  Nest what a body parser read (`req.body`, an upload's files by name and
  size); in Next.js, Nuxt and under `withTracepanel()` the bytes the app's
  own reads took from the request's stream, a copy of their start kept as
  they pass. JSON and forms have their secrets masked, text is cut at
  16 KB, and binary bodies are left out. A multipart form keeps its fields
  and its files by name and size, never their contents, however large the
  upload. JSON or a URL-encoded form past 16 KB is left out, since its
  secrets can't be masked from a part of it. A body the app never reads is
  not recorded, and Tracepanel never reads it or waits for it.
- The request's session as the handler left it: express-session's or
  cookie-session's `req.session` in Express and Nest, and in Nuxt the
  sessions h3's `useSession()` read (nuxt-auth-utils' among them). Each
  value is text, masked under a sensitive name and below one, and
  nuxt-auth-utils' `secure` data always is. Next.js and Bun have no
  session of their own, and a sealed cookie (iron-session, Auth.js) takes
  the app's secret to read, so none is recorded there: `setUser()` names
  the signed-in user instead.
- A form's POST that redirects to another page: the panel on that page
  lists the POST before it.
- SQL from `pg` and `mysql2` (and so Drizzle, Knex, Sequelize, TypeORM and
  Prisma's driver adapters), and from SQLite through `better-sqlite3`,
  Node's `node:sqlite` and `libsql`, with the line of your code that ran each
  statement. A statement no code of yours made, such as a session store's,
  names the library code that asked for it, past the driver and the ORM;
  so do Redis and MongoDB commands. Prisma's operations show as steps.
- Transactions: BEGIN … COMMIT (or ROLLBACK) on a `pg` client, a `mysql2`
  connection or a SQLite database, and better-sqlite3's `db.transaction()`,
  with its statements and the calls made inside it, and its savepoints.
- The console's EXPLAIN of a SQLite query (EXPLAIN QUERY PLAN) runs on the
  app's own connection, so a database in memory has a plan too.
- Redis commands (`ioredis`, `redis`) and MongoDB commands, with their own
  N+1 and duplicates.
- Outgoing HTTP calls: `fetch()`, and `node:http` clients such as axios, on
  Node and on Bun.
- BullMQ: each job a worker runs is a task, each job the app adds a step.
  While a job is in flight, the console's Tasks page lists it under Now:
  queued, running in its worker, or waiting for its next attempt, and the
  workers that run them.
- Logs made during a request: `console` calls, Nest's `Logger`, and pino's
  and winston's loggers, with their fields and the error they carry.
- Errors thrown in a handler, with your frames, their source and their
  local variables. Node's inspector reads the variables as the error is
  thrown, in your own frames only, while a request runs; a value under a
  name such as `password` or `token` is masked, and a long one is cut. A
  caller waiting on an `await` has none. Each error read costs about a
  millisecond, at most 50 a second; a process under a debugger
  (`--inspect`) is left alone.
- Where a request's time goes in code, for the console's flame graph, when
  it asks: the panel's Profile toggle, or an `X-Tracepanel-Profile: 1`
  header. V8's profiler samples the whole process, and one event loop runs
  every request at once, so a profile keeps the samples taken while its
  request was the only one running, and counts the rest
  (`tracepanel.dropped_samples`). Time spent waiting on I/O is not in it.
  Every profile counts the garbage collector's runs and their pauses.
  A request profiled because it asked asks the same of the apps it calls:
  each call that carries a `traceparent` (fetch, node:http, axios, got)
  carries `X-Tracepanel-Profile` too, so the panel's toggle profiles the
  whole chain. `TRACEPANEL_PROFILE=1` asks nothing of them: each app's own
  setting decides.
- A profile's memory too, when asked: `X-Tracepanel-Profile: memory`, the
  `tracepanel_profile=memory` cookie (the panel's Profile toggle offers
  it), or `TRACEPANEL_PROFILE_MEMORY=1`. V8's sampling heap profiler takes
  about one allocation in every 32 KB with its stack: the profile shows the
  heap's peak above where the request started, what V8 allocated in all
  (on Node 26), and the 50 sites whose allocations still lived at its end.
  The heap is the whole process's, so a request that ran beside others says
  so. It costs: code runs about 15% slower while it is sampled, and reading
  the sampler's profile makes V8 collect the whole heap once at the end of
  each such request, after its response, which stops the process for a few
  milliseconds on a small heap and over 100 ms on a heap of a few hundred
  MB. Leave it off when you measure time. Not on Bun.
- The caller's trace, when a request carries a W3C `traceparent`: the agent
  links the two.

## Your own steps and traces

```js
import { span, trace } from "@tracepanel/js";

await trace("nightly cleanup", async () => {
  await span("load stale rows", () => loadStaleRows());
});
```

`trace()` makes a script or a scheduled job a trace of its own, and inside a
request it is a step. `span()` is a step of the current trace. Outside
development they run the function and nothing else. Run a script with
`npx tracepanel run node script.js`.

## In tests

The Vitest plugin turns what Tracepanel finds into test failures, so an N+1
query fails CI before it reaches production. Add it to the Vitest config:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { tracepanel } from "@tracepanel/js/vitest";

export default defineConfig({
  plugins: [tracepanel()], // or tracepanel({ failOn: ["n+1", "duplicates", "slow-sql"] })
});
```

Each test runs as a trace named after the test, with its queries in it. A
request the test makes of a server it started (supertest, `fetch()`) is a
trace of its own, linked to the test's in the console. Work in `beforeAll` is
outside every test's trace; `beforeEach` and `afterEach` run inside it.

When the test passes, the agent looks at its traces. An issue of a kind in
`failOn` (`n+1` and `duplicates` by default) fails the test with the issue,
its query, the line of code that ran it and a link to the trace:

```text
AssertionError: tracepanel found 1 issue in this test:

N+1: 4 similar queries · SELECT authors
  SELECT name FROM authors WHERE id = $1
  at src/books.ts:28 in listBooks
  in GET /books → http://127.0.0.1:52068/#/t/01M60NB74Q6T9AXZGMFJ7V8FB1
  Load the related rows with the parent rows (a join, or one batched query) instead of one query per row.

The test's trace: http://127.0.0.1:52068/#/t/01M60NB74J4Q5VDHCJD1Z4T1J7
Allowed here with the test's option { meta: { tracepanel: { allow: ["n+1"] } } }.
```

The `tracepanel` meta changes the rules for a test or a `describe()`, and
`testTrace()` and `maxQueries()` count queries inside the test:

```ts
import { maxQueries, testTrace } from "@tracepanel/js/vitest";

test("feed", { meta: { tracepanel: { maxQueries: 10, allow: ["n+1"] } } }, async () => {
  await request(app).get("/feed");
  expect(testTrace().queries).toBeLessThanOrEqual(10);
  await maxQueries(2, () => request(app).get("/feed?page=2"));
});
```

`failOn` replaces the kinds that fail the test, `allow` takes kinds out of
them, and `maxQueries` caps the queries of the test and its requests.
`await testTrace().issues()` lists what the agent found in the test's
requests so far.

The plugin starts the project's agent when none is running. Without an agent
(`TRACEPANEL_AGENT=off`) the tests run without findings, and one warning says
so. Query counts need no agent.

## The signed-in user

```js
import { setUser } from "@tracepanel/js";

setUser({ id: customer.id, username: customer.email });
```

Call `setUser()` where the app knows who is signed in, such as its auth
middleware. The request's trace gets `user.id`, and `user.username` and
`user.email` when given, as the Python SDK records them. `setUser(null)`
marks a request nobody signed in to. The username and email stay on your
machine. Outside a trace it does nothing.

## Settings

Environment variables, as in the Python SDK:

| Variable | Default | What it sets |
| --- | --- | --- |
| `TRACEPANEL_ENABLED` | on unless `NODE_ENV=production` | `0` turns Tracepanel off, `1` on |
| `TRACEPANEL_SERVICE` | `package.json`'s name | the app's name in the console |
| `TRACEPANEL_DIR` | `.tracepanel` | the project's store, where the agent keeps the traces |
| `TRACEPANEL_AGENT_BIN` | the one npm installed | the agent to start, such as a build of your own |
| `TRACEPANEL_AGENT` | `auto` | an agent elsewhere (`tcp:host:port`), never started |
| `TRACEPANEL_N_PLUS_ONE_THRESHOLD` | `3` | repeats that make an N+1 |
| `TRACEPANEL_N_PLUS_ONE_MIN_MS` | `5` | for Redis and other fast stores, the time repeats must take together |
| `TRACEPANEL_SLOW_SQL_MS` | `100` | a slow query, SQL or MongoDB |
| `TRACEPANEL_SLOW_HTTP_MS` | `500` | a slow outgoing HTTP call |
| `TRACEPANEL_LONG_TRANSACTION_MS` | `500` | a long transaction |
| `TRACEPANEL_QUEUE_WAIT_MS` | `1000` | a task that waited long for a worker |
| `TRACEPANEL_LARGE_RESULT_ROWS` | `1000` | a query without a LIMIT that read too many rows |
| `TRACEPANEL_WIDGET` | on (off in tests) | `0` leaves the app's HTML pages without the widget's script |
| `TRACEPANEL_CAPTURE_REQUEST` | on | `0` stops keeping each request's headers, query, cookies and body |
| `TRACEPANEL_CAPTURE_LOCALS` | on | `0` stops reading an error's local variables |
| `TRACEPANEL_PROFILE` | off | `1` profiles every trace, not only a request that asks |
| `TRACEPANEL_PROFILE_MEMORY` | off | `1` profiles every profiled trace's memory too |
| `TRACEPANEL_PROFILE_ENABLED` | on | `0` profiles nothing, and the console offers no Profile toggle |
| `TRACEPANEL_PROFILE_INTERVAL_MS` | `1` | how often a profiled trace is sampled |

## Command line

| Command | What it does |
| --- | --- |
| `tracepanel run <command>` | runs a Node command with Tracepanel on, such as `tracepanel run node server.js` |
| `tracepanel dev` | runs the agent in the foreground, with the console on http://127.0.0.1:8765/ |
| `tracepanel mcp` | gives an AI coding agent your traces over MCP |

## Documentation

The documentation is at
[tracepanel.dev/docs/javascript](https://tracepanel.dev/docs/javascript):
installing, the integrations, the browser recording, settings and the command
line. The panel, the console and the issues are the same in every framework,
under [tracepanel.dev/docs](https://tracepanel.dev/docs).

## Links

- [tracepanel](https://github.com/tracepanel/tracepanel): what Tracepanel finds,
  how it works, privacy, and the agent this package installs
- [CHANGELOG.md](CHANGELOG.md): what changed in each version

## License

Licensed under the [MIT License](LICENSE). The agent npm installs with it,
`@tracepanel/agent`, is free to use under the
[FSL-1.1-ALv2](https://github.com/tracepanel/tracepanel/blob/main/LICENSE):
source available, and Apache-2.0 two years after each release.
