// `node --import tracepanel/register app.js`: OpenTelemetry for the app, with Tracepanel's span processor. Loaded
// before the app, it can instrument both CommonJS and ES modules (the ESM loader hook goes in first).

import { start } from "./setup.js";

start();
