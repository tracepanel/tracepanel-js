# Tracepanel for Node.js

**See what your app does on every request.** Tracepanel records each request
of your Node.js app with its SQL queries, logs and errors. It finds N+1
queries, duplicate queries and slow SQL, and names the line of code to fix.
You read it in a panel on your pages and in a console.

It runs while you develop, and everything stays on your machine.

This package is in early development and not on npm yet.

## Setup

```bash
npm install tracepanel
```

Start the app with Tracepanel loaded before it, so OpenTelemetry can
instrument its HTTP server, Express and its database driver:

```bash
node --import tracepanel/register server.js
# or
npx tracepanel run node server.js
```

Add the middleware to an Express app. It puts the badge on HTML pages and
gives every response its trace id:

```js
import express from "express";
import { tracepanel } from "tracepanel/express";

const app = express();
app.use(tracepanel());
```

Open a page and click the badge in the corner. Tracepanel starts its agent on
the first request. The agent keeps the traces in `.tracepanel/` in your
project and serves the console.

Tracepanel is on unless `NODE_ENV` is `production`. `TRACEPANEL_ENABLED=0`
turns it off and `TRACEPANEL_ENABLED=1` turns it on.

## What it records

- HTTP requests, with the route and the Express handler that served them.
- SQL from `pg` and `mysql2`, with the line of your code that ran each
  statement.
- `console` calls made during a request.
- Errors thrown in a handler, with your frames and their source.

## Command line

| Command | What it does |
| --- | --- |
| `tracepanel run <command>` | runs a Node command with Tracepanel on |
| `tracepanel dev` | runs the agent in the foreground, with the console on http://127.0.0.1:8765/ |
| `tracepanel mcp` | gives an AI coding agent your traces over MCP |

## License

Licensed under the [MIT License](LICENSE).
