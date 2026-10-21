# Changelog

## Unreleased

### Added

- The request's body in Next.js (App Router route handlers and server
  actions, Pages Router API routes), Nuxt, and Bun.serve or any handler
  under `withTracepanel()` (Hono, Elysia), for the panel's Request tab, as
  Express and the Python SDK record it: `http.request.body`, up to 16 KB,
  with `http.request.body.truncated` past it. JSON and forms have the values
  under sensitive names masked, text is cut, binary is left out. A
  multipart form keeps its fields and its files by name and size, never
  their contents, however large the upload. JSON or a URL-encoded form past
  16 KB is left out: its secrets can't be masked from a part of it. Only
  what the app read is recorded: each piece passes a tap on its way to the
  app, which keeps a copy of the start and reads nothing itself. A body the
  app never reads is not waited for, and an upload still streams.
  `TRACEPANEL_CAPTURE_REQUEST=0` leaves the body alone.
- The request's session, for the panel's Request tab, as the Python SDK
  records it: `session.<key>` for each value the session holds as the
  handler left it, as text cut as a local variable is. A value under a
  sensitive name is masked, and so is one under it at any depth; Passport's
  `passport` (who is signed in) is kept, nuxt-auth-utils' `secure` always
  masked. Express and Nest read express-session's or cookie-session's
  `req.session`, Nuxt the sessions h3's `useSession()` read, each under its
  name when there are several. Next.js and Bun have no session of their
  own, and a sealed cookie (iron-session, Auth.js) can't be read without
  the app's secret, so they record none. `TRACEPANEL_CAPTURE_REQUEST=0`
  turns it off with the rest of the request.
- A database call no code of the app's made, such as a session store's
  query before any handler runs, has `code.caller`, as the Python SDK
  records it: the library code that asked for it, the first frame past the
  driver, its ORM, OpenTelemetry and Tracepanel
  (`connect-pg-simple/index.js:… in PGStore.get`). The panel shows it marked
  as a library's. SQL statements, transactions, Prisma operations, Redis
  and MongoDB commands have it; a call with the app's line on its stack
  does not.
- A request's profile, as the Python SDK records it: where its time went in
  code, for the console's flame graph. A request asks with an
  `X-Tracepanel-Profile: 1` header or the panel's `tracepanel_profile=1`
  cookie, set while its Profile toggle is on: in Express, Nest, Next.js and
  Nuxt, and under `withTracepanel()` on Node.
  `TRACEPANEL_PROFILE=1` profiles every trace, `TRACEPANEL_PROFILE_ENABLED=0`
  none, and `TRACEPANEL_PROFILE_INTERVAL_MS` sets how often it samples
  (every millisecond by default). The hello says `profile` while it is on.
  V8's profiler runs through Node's inspector only while traces are
  profiled, and stops 30 seconds after the last one. It samples the whole
  process: a profile keeps what was sampled while its request was the only
  one running, and counts the rest in `tracepanel.dropped_samples`. Waiting
  on I/O takes no samples. Bun has no profile.
- An error's frames carry their local variables, as the Python SDK records
  them: the app's own frames, each value as text, cut as Python cuts a
  `repr()`, and masked under a sensitive name. Node's inspector pauses the
  app as an error is thrown in a request, only while one runs and at most 50
  times a second, and reads the frames then; a caller waiting on an
  `await` has none. The errors Next.js throws to steer a render (a
  `redirect()`, a `notFound()`, a bail-out) are not read and count against
  no limit. `TRACEPANEL_CAPTURE_LOCALS=0` turns it off; a process
  under a debugger is left alone, and Bun has none. A frame without locals
  now sends `null`, as the Python SDK does, instead of an empty object.
- A streamed HTML page gets the panel too: one written in pieces without a
  `Content-Length` in Express, a `ReadableStream` body from `Bun.serve` or
  another fetch handler under `withTracepanel()`. The script goes in right
  after the `<head>` (or `<body>`) opens, as the pieces pass, and nothing
  else is held: only a tag cut between two pieces waits for its end. A
  streamed response also gets the badge's headers, with the time so far. A
  compressed page, or one that declares its size, is left as it is.
- What each request carried, for the panel's Request tab, as the Python SDK
  records it: its headers, query and cookies, the body as far as the app
  read it, and the response's headers. Values under sensitive names
  (`password`, `token`, `session`, `csrf`, `api_key` and the like) are
  masked, and `Set-Cookie` always is. The body is what a body parser left
  in `req.body` in Express and Nest, with an upload's files by name and
  size, up to 16 KB; Tracepanel never reads a request's stream itself, so
  `withTracepanel()`, Next.js and Nuxt record no body.
  `TRACEPANEL_CAPTURE_REQUEST=0` turns it off; the agent's hello says
  `request` while it is on.
- A form's POST that redirects shows in the next page's panel: a redirect
  that answers a page's navigation sets the short-lived
  `tracepanel_redirect` cookie the widget reads, in Express, under
  `withTracepanel()`, Next.js and Nuxt.
- pino and winston: each log made during a request or a task goes to its
  trace, with no change to the app's code. The level is on the same scale as
  console's, the logger's fields (a pino child's bindings, winston's
  `defaultMeta` and metadata) are `extra.*` attributes, secrets masked, and
  the error's stack is the log's exception. pino's logger name is the
  record's logger. What the logger prints through `console` (winston's
  Console transport with `forceConsole`) is not recorded a second time.
- BullMQ's jobs in flight, for Now on the console's Tasks page, as the
  Python SDK sends Celery's and RQ's: task events go to the agent as a job
  is added (with the request and step that added it), as a worker starts
  it, and as it ends or waits for its next attempt, with the error. A
  worker says it is there as it starts running, then every 30 seconds with
  the jobs it runs, so a job whose process was killed leaves the list. A
  job's data shows at a glance, as JSON cut to 200 characters, values under
  sensitive keys masked. The hello says `live_tasks` once BullMQ is loaded.

### Changed

- Express no longer holds a response written in pieces without a
  `Content-Length` until it ends: it goes out as the app writes it.

### Fixed

- BullMQ: a job that threw an `UnrecoverableError` is a failure, attempts
  left or not, as BullMQ has it, not a retry; one that threw to move itself
  on (a `DelayedError`, `WaitingChildrenError`, a rate limit) is not a
  failure on its last attempt.
- A page whose first tag is `<header>` gets the script in its `<head>`, not
  after the `<header>`.
- `Bun.serve`: a compressed HTML page is no longer read as text for the
  script, which broke it.

## 0.3.4 (2026-10-19)

Needs `@tracepanel/agent` 0.3.6 (installed with it): its panel lists a page's
calls under the view or action that made them.

### Added

- Next.js: in development the app's own server answers `/__tracepanel__/`
  with the console of the project's agent, as the Vite plugin does. It reads
  the agent's address on each request, starts the agent when none runs and
  a new one when it went away, and answers this machine only. The badge
  loads from there.
- Next.js: `<Tracepanel />` records the pages in the browser too. Each view
  and action is a trace, and its calls carry a traceparent, to the app's
  origin and to those in `propagateTo`. `browser={{ service, propagateTo }}`
  sets its options and `browser={false}` leaves it out. The recording is
  inline in `<head>`, so it wraps `fetch` before the app's scripts run.

### Changed

- `ignoreSources` of `record()` matches a part of a script's path, not only
  its start: Next.js's chunk names begin with a hash.

### Fixed

- A request to `/__tracepanel__/` is no trace of the app's, in any
  framework. A hand-made proxy to the console in Next.js listed the page's
  `POST /__tracepanel__/api/ingest` among the app's requests.
- The browser recording marks a Response with its view or action as it
  arrives, before anything else runs, so a wrapper of `fetch` around it
  (the widget's) always finds the mark.
- A console record of the page keeps the line that logged it under a
  wrapper of `console` added after the recording, such as Next.js's dev
  overlay. It named the wrapper's line before.

## 0.3.3 (2026-10-17)

### Fixed

- EXPLAIN from the console works on the queries of a Nuxt app. Nitro's dev
  server imports pg by its ES module's file URL, and the hook that remembers
  the app's databases never saw it load. EXPLAIN then had no database, or ran
  on another one the app had queried. pg and mysql2 handed over as an ES
  module's namespace were missed the same way.

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
