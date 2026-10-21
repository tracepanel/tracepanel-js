# Tracepanel for Node.js and Bun

[![CI](https://github.com/tracepanel/tracepanel-js/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tracepanel/tracepanel-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tracepanel/js)](https://www.npmjs.com/package/@tracepanel/js)
[![Node.js](https://img.shields.io/node/v/@tracepanel/js)](https://www.npmjs.com/package/@tracepanel/js)

**See what your app does on every request.** Tracepanel records each request
of your Express, NestJS, Next.js, Nuxt or Bun app with its SQL queries, logs
and errors. It finds N+1 queries, duplicate queries and slow SQL, and names
the line of code to fix. You read it in a panel on your pages and in a
console.

It runs while you develop, and everything stays on your machine.

## Setup

```bash
npm install @tracepanel/js
```

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
`withTracepanel()` wraps any fetch handler, such as Hono's `app.fetch`:

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
links it to the API's trace. `propagateTo` names other origins, whose CORS
must allow the header:

```ts
tracepanel({ dir: "../backend", browser: { service: "shop-web", propagateTo: ["http://127.0.0.1:8000"] } });
```

`browser: false` leaves the recording out. Vite's own client logs (its
connection, hot reload) stay out of the pages' traces.

Without Vite, call `record()` from `@tracepanel/js/browser` in the page, with the
console on the page's origin (`api`, `/__tracepanel__/` by default).
`ignoreSources` takes the path prefixes of scripts whose console isn't the
page's, such as a dev server's client.

## What it records

- HTTP requests, with the route and the handler that served them, and what
  each one carried: its headers, query and cookies, the body as far as the
  app read it, and the response's headers. Values under names such as
  `password`, `token`, `session` or `csrf` are masked, and they never leave
  your machine. A body is what a body parser read (`req.body` in Express and
  Nest, an upload's files by name and size), up to 16 KB; under
  `withTracepanel()`, Next.js and Nuxt the framework reads the body for the
  app, so it is left out.
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
  Prisma's driver adapters), with the line of your code that ran each
  statement. A statement no code of yours made, such as a session store's,
  names the library code that asked for it, past the driver and the ORM;
  so do Redis and MongoDB commands. Prisma's operations show as steps.
- Transactions: BEGIN … COMMIT (or ROLLBACK) on a `pg` client or a `mysql2`
  connection, with its statements and the calls made inside it, and its
  savepoints.
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
| `TRACEPANEL_CAPTURE_REQUEST` | on | `0` stops keeping each request's headers, query, cookies and body |
| `TRACEPANEL_CAPTURE_LOCALS` | on | `0` stops reading an error's local variables |
| `TRACEPANEL_PROFILE` | off | `1` profiles every trace, not only a request that asks |
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

## License

Licensed under the [MIT License](LICENSE).
