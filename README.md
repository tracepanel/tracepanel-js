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
| **Profiling** | Where a request's CPU time goes, and its memory and garbage collections when you ask for them, on Node. |
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
turns it off and `TRACEPANEL_ENABLED=1` turns it on. The app's first request
starts the agent, which keeps the traces in `.tracepanel/` and serves the
console. Open a page and click the badge in the corner.

### Express

Start the app with Tracepanel loaded before it, and add the middleware. It
puts the badge on HTML pages and gives every response its trace id:

```bash
node --import @tracepanel/js/register server.js
```

```js
import express from "express";
import { tracepanel } from "@tracepanel/js/express";

const app = express();
app.use(tracepanel());
```

The flag loads Tracepanel before the app's imports, which `import
"@tracepanel/js/register"` in `server.js` can't do. Without the flag, let the
CLI add it:

```json
{ "scripts": { "dev": "tracepanel run node server.js" } }
```

or start from a file that loads Tracepanel, then the app:

```js
// main.js, run with `node main.js`
import "@tracepanel/js/register";
await import("./server.js");
```

### Fastify

Load Tracepanel before the app as for Express, and register the plugin
before the routes:

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

Each request is named by its route (`GET /books/:id`).

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

Each request is named by its `@koa/router` route.

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

On Bun, add the same middleware and serve the app with `serve()` from
`@tracepanel/js/bun` (see Bun below).

### NestJS

Nest runs on Express: load Tracepanel the same way and add the same
middleware in `main.ts`. Each request's handler is its controller method,
such as `BooksController.list`.

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

Add the plugin of your GraphQL server, and load Tracepanel and its
framework's middleware as above. GraphQL Yoga, on Express or any other
server:

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

Each request is named after its operation, such as `GraphQL query Books`,
and each of your resolvers is a step with its queries and calls under it.

### Next.js

Tracepanel goes in from the instrumentation hook. Keep the package out of the
bundles, and put the badge in the root layout:

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

In development the app's server serves the console at `/__tracepanel__/`.
`<Tracepanel />` also records the pages in the browser, and takes the Vite
plugin's options (see below). `browser={false}` leaves the recording out:

```tsx
<Tracepanel browser={{ service: "shop-web", propagateTo: ["http://127.0.0.1:8000"] }} />
```

### Nuxt

Add the module and start `nuxt dev` with Tracepanel loaded:

```ts
// nuxt.config.ts
export default defineNuxtConfig({ modules: ["@tracepanel/js/nuxt"] });
```

```bash
NODE_OPTIONS=--import=@tracepanel/js/register nuxt dev
```

### Bun

`serve()` is `Bun.serve` with each route traced under its pattern, and
`withTracepanel()` wraps any fetch handler, such as Elysia's `handle`. A Hono
app is `serve({ fetch: app.fetch })`, with its `tracepanel()` middleware:

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

A single-page app on Vite's dev server gets the badge from the plugin,
whatever serves its API, in Node or in Python. It serves the backend's
console on Vite's origin, from the backend project's `.tracepanel/`:

```ts
// vite.config.ts
import { tracepanel } from "@tracepanel/js/vite";

export default { plugins: [tracepanel({ dir: "../backend" })] };
```

A backend that serves its own console (Django, FastAPI) is named with
`console`:

```ts
tracepanel({ console: "http://localhost:8000/__tracepanel__/" });
```

The plugin also records the pages in the browser: each view and each click
or submit is a trace, with its API calls, errors and console output.
`propagateTo` names the API origins to link to the page's traces. Their CORS
must allow the `traceparent` and `X-Tracepanel-Profile` headers:

```ts
tracepanel({ dir: "../backend", browser: { service: "shop-web", propagateTo: ["http://127.0.0.1:8000"] } });
```

`browser: false` leaves the recording out. Without Vite, call `record()` from
`@tracepanel/js/browser` in the page.

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

- HTTP requests: route, handler, headers, query, cookies and the body the app
  read, secrets masked.
- The session as the handler left it: express-session, cookie-session, h3's
  `useSession()`.
- A form's POST that redirects, listed on the next page's panel.
- SQL from `pg` and `mysql2`, and so Drizzle, Knex, Sequelize, TypeORM and
  Prisma.
- SQLite from `better-sqlite3`, `node:sqlite` and `libsql`.
- The line of your code that ran each query.
- Transactions and their savepoints, with the statements inside them.
- Redis commands from `ioredis` and `redis`, and MongoDB commands.
- Outgoing HTTP calls from `fetch()` and `node:http` clients such as axios.
- BullMQ jobs as tasks, and the jobs in flight.
- Logs from `console`, pino, winston and Nest's `Logger`, with their fields.
- Errors thrown in a handler, with your frames, their source and local
  variables.
- Where a request's CPU time and memory go, when you ask for a profile, on
  Node.
- The caller's trace, when a request carries a W3C `traceparent`.

What each integration records, and its limits, are in
[Integrations](https://tracepanel.dev/docs/javascript/integrations).

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
outside every test's trace. `beforeEach` and `afterEach` run inside it.

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
`user.email` when given. `setUser(null)` marks a request nobody signed in
to. The username and email stay on your machine. Outside a trace it does
nothing.

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
