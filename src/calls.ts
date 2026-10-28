// Calls to other systems, as the agent and the other SDKs name them: an outgoing HTTP call (http.client), a Redis
// command (redis), a MongoDB command (mongodb). OpenTelemetry's instrumentations describe them; these are the
// Tracepanel spans' names and attributes.

import { createHash } from "node:crypto";
import type { Attrs } from "./model.js";

function first(attrs: Attrs, ...keys: string[]): unknown {
  for (const key of keys) {
    if (attrs[key] !== undefined) return attrs[key];
  }
  return undefined;
}

// Query parameters whose values are secrets: their values become "***".
const SECRET = /(token|key|secret|password|passwd|pwd|auth|signature|sig|session|credential)/i;

/** The URL without its credentials, and with secret query values masked. */
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET.test(name)) url.searchParams.set(name, "***");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/** An outgoing HTTP call: `GET api.example.com/users/42`. */
export function httpCall(attrs: Attrs): { name: string; attrs: Attrs } {
  const method = String(first(attrs, "http.request.method", "http.method") ?? "GET").toUpperCase();
  const raw = String(first(attrs, "url.full", "http.url") ?? "");
  let host = String(first(attrs, "server.address", "net.peer.name") ?? "");
  let path = "/";
  let port = first(attrs, "server.port", "net.peer.port");
  let scheme = "http";
  try {
    const url = new URL(raw);
    host = url.hostname;
    path = url.pathname || "/";
    scheme = url.protocol.replace(":", "");
    port = url.port ? Number(url.port) : scheme === "https" ? 443 : 80;
  } catch {
    // No full URL: the host and port the instrumentation gave.
  }
  const status = first(attrs, "http.response.status_code", "http.status_code");
  return {
    name: `${method} ${host}${path}`,
    attrs: {
      "http.request.method": method,
      "url.full": safeUrl(raw),
      "url.scheme": scheme,
      "server.address": host,
      "server.port": port ?? null,
      ...(status === undefined ? {} : { "http.response.status_code": status }),
    },
  };
}

export function isRedis(attrs: Attrs): boolean {
  return first(attrs, "db.system.name", "db.system") === "redis";
}

/** A Redis command: `GET post:42:summary`, its key, and where the server is. */
export function redisCall(attrs: Attrs, spanName: string): { name: string; attrs: Attrs } {
  const statement = String(first(attrs, "db.query.text", "db.statement") ?? "");
  const words = statement.split(/\s+/).filter(Boolean);
  const command = String(first(attrs, "db.operation.name", "db.operation") ?? words[0] ?? spanName).toUpperCase();
  const key = words[1] && words[1] !== "?" ? words[1] : null;
  const namespace = first(attrs, "db.namespace", "db.redis.database_index");
  return {
    name: key && command !== "PIPELINE" && command !== "MULTI" ? `${command} ${key}` : command,
    attrs: {
      "db.system": "redis",
      "db.operation": command,
      "redis.key": key,
      "redis.alias": namespace === undefined || namespace === null || namespace === 0 ? "redis" : `redis/${namespace}`,
      "server.address": first(attrs, "server.address", "net.peer.name") ?? null,
      "server.port": first(attrs, "server.port", "net.peer.port") ?? null,
    },
  };
}

/**
 * A MongoDB command as its span's statement: JSON, with the Maps the driver makes of what the app wrote as objects
 * (a find's sort, `{ asked: -1 }`, is a Map by then: JSON.stringify alone makes it `{}`).
 */
export function mongoStatement(command: unknown): string {
  return JSON.stringify(command, (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value));
}

export function isMongo(attrs: Attrs): boolean {
  return first(attrs, "db.system.name", "db.system") === "mongodb";
}

// Where a command carries the app's values: they become "?" in its shape, as in the Python SDK.
const VALUES = new Set(["filter", "query", "documents", "updates", "deletes", "pipeline", "q", "u", "update"]);
// What the driver adds for itself.
const NOISE = new Set([
  "lsid",
  "$clusterTime",
  "$db",
  "txnNumber",
  "$readPreference",
  "autocommit",
  "startTransaction",
]);

function shape(value: unknown, values: unknown[]): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) {
      values.push(...value);
      return ["?"];
    }
    return value.map((item) => shape(item, values));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, values)]));
  }
  values.push(value);
  return "?";
}

/** A MongoDB command: `find users`, its shape with the values as "?", and a hash of the values (duplicates). */
export function mongoCall(attrs: Attrs, spanName: string): { name: string; attrs: Attrs } {
  const operation = String(first(attrs, "db.operation.name", "db.operation") ?? spanName.split(".").at(-1) ?? "");
  const collection = first(attrs, "db.collection.name", "db.mongodb.collection");
  const raw = String(first(attrs, "db.query.text", "db.statement") ?? "");
  let statement = raw;
  let hash: string | null = null;
  try {
    const command = JSON.parse(raw) as Record<string, unknown>;
    const values: unknown[] = [];
    const shaped = Object.fromEntries(
      Object.entries(command)
        .filter(([key]) => !NOISE.has(key))
        .map(([key, value]) => [key, VALUES.has(key) ? shape(value, values) : value]),
    );
    statement = JSON.stringify(shaped);
    hash = createHash("sha1").update(JSON.stringify(values)).digest("hex").slice(0, 12);
  } catch {
    // Not JSON: kept as the instrumentation wrote it.
  }
  return {
    name: collection ? `${operation} ${collection}` : operation,
    attrs: {
      "db.system": "mongodb",
      "db.operation": operation,
      "db.namespace": first(attrs, "db.namespace", "db.name") ?? null,
      "db.collection.name": collection ?? null,
      "db.statement": statement.length > 2000 ? `${statement.slice(0, 1999)}…` : statement,
      "db.params_hash": hash,
      "server.address": first(attrs, "server.address", "net.peer.name") ?? null,
      "server.port": first(attrs, "server.port", "net.peer.port") ?? null,
    },
  };
}
