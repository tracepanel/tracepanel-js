# Tracepanel for Node.js and Bun

**See what your app does on every request.** Tracepanel records each request
of your Express, NestJS, Next.js, Nuxt or Bun app with its SQL queries, logs
and errors. It finds N+1 queries, duplicate queries and slow SQL, and names
the line of code to fix. You read it in a panel on your pages and in a
console.

It runs while you develop, and everything stays on your machine.

## Setup

```bash
npm install tracepanel
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
node --import tracepanel/register server.js
```

```js
import express from "express";
import { tracepanel } from "tracepanel/express";

const app = express();
app.use(tracepanel());
```

### NestJS

Nest runs on Express: load Tracepanel the same way and add the same
middleware in `main.ts`. Each request's handler is its controller method,
such as `BooksController.list`, and the Nest `Logger`'s records go to the
request's trace. An `HttpException` that answers below 500 is the response,
not an error.

```bash
node --import tracepanel/register dist/main.js
```

```ts
import { NestFactory } from "@nestjs/core";
import { tracepanel } from "tracepanel/express";
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
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("tracepanel/next")).register();
}
```

```ts
// next.config.ts
const config = { serverExternalPackages: ["tracepanel"] };
export default config;
```

```tsx
// app/layout.tsx
import { Tracepanel } from "tracepanel/next/widget";

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

### Nuxt

Add the module and start `nuxt dev` with Tracepanel loaded, so it hooks the
database driver as Nitro loads it:

```ts
// nuxt.config.ts
export default defineNuxtConfig({ modules: ["tracepanel/nuxt"] });
```

```bash
NODE_OPTIONS=--import=tracepanel/register nuxt dev
```

The module names each request by its route (`/api/books/:id`), puts the
badge on server-rendered pages, and records the errors h3 answers with a 500.

### Bun

`serve()` is `Bun.serve` with each route traced under its pattern, and
`withTracepanel()` wraps any fetch handler, such as Hono's `app.fetch`:

```bash
bun --preload tracepanel/register server.ts
```

```ts
import { serve } from "tracepanel/bun";

serve({
  routes: {
    "/api/books/:id": async (req) => Response.json(await findBook(req.params.id)),
  },
});
```

## What it records

- HTTP requests, with the route and the handler that served them.
- SQL from `pg` and `mysql2` (and so Drizzle, Knex, Sequelize, TypeORM and
  Prisma's driver adapters), with the line of your code that ran each
  statement. Prisma's operations show as steps.
- Redis commands (`ioredis`, `redis`) and MongoDB commands, with their own
  N+1 and duplicates.
- Outgoing HTTP calls: `fetch()`, and `node:http` clients such as axios.
- BullMQ: each job a worker runs is a task, each job the app adds a step.
- `console` calls made during a request, and Nest's `Logger`.
- Errors thrown in a handler, with your frames and their source.
- The caller's trace, when a request carries a W3C `traceparent`: the agent
  links the two.

## Your own steps and traces

```js
import { span, trace } from "tracepanel";

await trace("nightly cleanup", async () => {
  await span("load stale rows", () => loadStaleRows());
});
```

`trace()` makes a script or a scheduled job a trace of its own, and inside a
request it is a step. `span()` is a step of the current trace. Outside
development they run the function and nothing else. Run a script with
`npx tracepanel run node script.js`.

## Settings

Environment variables, as in the Python SDK:

| Variable | Default | What it sets |
| --- | --- | --- |
| `TRACEPANEL_ENABLED` | on unless `NODE_ENV=production` | `0` turns Tracepanel off, `1` on |
| `TRACEPANEL_SERVICE` | `package.json`'s name | the app's name in the console |
| `TRACEPANEL_N_PLUS_ONE_THRESHOLD` | `3` | repeats that make an N+1 |
| `TRACEPANEL_N_PLUS_ONE_MIN_MS` | `5` | for Redis and other fast stores, the time repeats must take together |
| `TRACEPANEL_SLOW_SQL_MS` | `100` | a slow query, SQL or MongoDB |
| `TRACEPANEL_SLOW_HTTP_MS` | `500` | a slow outgoing HTTP call |
| `TRACEPANEL_LONG_TRANSACTION_MS` | `500` | a long transaction |
| `TRACEPANEL_QUEUE_WAIT_MS` | `1000` | a task that waited long for a worker |
| `TRACEPANEL_LARGE_RESULT_ROWS` | `1000` | a query without a LIMIT that read too many rows |

## Command line

| Command | What it does |
| --- | --- |
| `tracepanel run <command>` | runs a Node command with Tracepanel on |
| `tracepanel dev` | runs the agent in the foreground, with the console on http://127.0.0.1:8765/ |
| `tracepanel mcp` | gives an AI coding agent your traces over MCP |

## License

Licensed under the [MIT License](LICENSE).
