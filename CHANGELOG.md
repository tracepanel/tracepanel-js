# Changelog

## 0.3.2 (2026-10-17)

### Added

- Transactions: BEGIN (or START TRANSACTION) on a pg client or a mysql2
  connection opens a `transaction` span that its COMMIT or ROLLBACK ends,
  with a nested `savepoint` span for each SAVEPOINT. The statements on that
  connection and the calls made meanwhile go inside it, so the agent finds
  long transactions and HTTP calls inside one, as it does for Python.
- `setUser({ id, username, email })` names the signed-in user on the
  request's trace (`user.id`, `user.username`, `user.email`), as the Python
  SDK does for Django's user.

### Changed

- Installs any `@tracepanel/agent` 0.3 from 0.3.1 on (`~0.3.1`), rather
  than exactly its own version. A minor version is still released together
  with the agent's. A patch of either now comes out on its own.

### Fixed

- Next.js: a `fetch()` is one `http.client` span, not two. Next's own
  span of it made a second one, which the agent could take for a
  duplicate call.
- `code.origin` of a `fetch()` is the line that called it. Node's undici
  starts the call's span away from the app's code, and it took the line of
  the span before. A span under a deep stack of the driver's own (a query
  inside a transaction) finds the app's line too.
- `next dev` and `nuxt dev`: `code.origin` and an error's frames point at
  the app's source, not at the dev server's bundle
  (`.next/dev/server/chunks/*.js`, `.nuxt/dev/index.mjs`). A frame in a
  file with a source map is read through it, and the dependencies bundled
  with the app are not the app's code.
- Bun: `fetch()` and `node:http` calls are `http.client` spans with the
  same attributes as on Node, and send their W3C traceparent. Under
  `bun --preload @tracepanel/js/register` neither made a span before. A
  request to `serve()` or `withTracepanel()` reads the caller's
  traceparent, so the agent links the two traces.

## 0.3.1 (2026-10-17)

It needs `@tracepanel/agent` 0.3.1, installed with it: its console's script
is a fifth smaller, and the source around an error's frame is highlighted
in JavaScript, TypeScript, Java and Kotlin too.

### Changed

- Installs `@tracepanel/agent` 0.3.1.

## 0.3.0 (2026-10-15)

It needs `@tracepanel/agent` 0.3.0, installed with it: its console finds
logs by the spans they were written in and follows calls to another
project's app to its trace.

### Added

- EXPLAIN of a query from the console: the app says it can in its hello,
  and runs the EXPLAIN the agent sends down the connection on a session of
  its own, with the settings of its pg or mysql2 connection, rolled back.
  pg's parameters are recorded with the query (`db.params`) for it.

### Fixed

- A trace keeps at most 2,000 spans and 1,000 log records, as the agent
  stores it: its earliest spans, each with its parent, and its first
  records. How many went is counted (`tracepanel.dropped_spans`, `_logs`),
  and one runaway request no longer grows the app's memory without end.

## 0.2.0 (2026-10-14)

The first release on npm. It needs `@tracepanel/agent` 0.2.0, installed with
it.

### Added

- Traces of Express, NestJS, Next.js, Nuxt and Bun apps: each request with
  its route and handler, SQL from `pg` and `mysql2` (and so Drizzle, Knex,
  Sequelize, TypeORM and Prisma's driver adapters) with the line of code that
  ran it, Redis and MongoDB commands, outgoing `fetch()` and `node:http`
  calls, BullMQ jobs, `console` calls and Nest's `Logger`, and errors with
  their source. N+1 queries, duplicates and slow SQL are found by the agent.
- One install: `npm install @tracepanel/js` brings the instrumentations and the
  agent, which starts on the first request and keeps the traces in
  `.tracepanel/`.
- The panel's badge on HTML pages (`@tracepanel/js/express`, Next.js's
  `<Tracepanel />`, Nuxt's module, `@tracepanel/js/bun`), and each response's
  trace id for it.
- An SPA on Vite's dev server (`@tracepanel/js/vite`) gets the panel, whatever
  serves its API. The plugin starts the backend's agent when none answers,
  and lets only this machine reach the console.
- `@tracepanel/js/browser` records a page's views and actions (`click "Save"`)
  with their `fetch()` calls, errors and console, and links its calls to the
  backend's traces with a `traceparent`. The console lists them in Pages.
- `span()` and `trace()` for your own steps and traces, and the
  `tracepanel` command: `run`, `dev` for the agent in the foreground, and
  `mcp` for AI coding agents.
