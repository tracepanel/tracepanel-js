# Changelog

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
