// What a request carried, as attributes of its trace: headers, query, cookies, the body the app read, the response's
// headers; and the cookie that tells the widget which requests redirected to the page it is on.
//
// They stay on this machine (the agent keeps them out of what it sends anywhere), and the values under a sensitive
// name are masked before they are recorded. A body is only what the app read itself (a body parser's `req.body`), up
// to MAX_BODY characters: Tracepanel never reads a request's stream for the app.

import type { Attrs } from "./model.js";

/** How much of a body is kept, in characters. */
export const MAX_BODY = 16_384;
export const MASK = "********";
const SENSITIVE = /pass(word|wd)?|secret|token|api_?key|auth|cookie|session|csrf|signature|private/i;
/** A response's cookies are a session's keys, whatever their name. */
const ALWAYS_MASKED = new Set(["set-cookie"]);
/** A form as people read it: encoded, but its spaces, masks and file notes as they are. */
const READABLE = /^[A-Za-z0-9_.~*<>,. /:@-]$/;
/** A query's values: encoded as a form's, `+` for a space, masks and paths as they are. */
const QUERY_SAFE = /^[A-Za-z0-9_.~*/:-]$/;

/** A name as one segment of an attribute's key (content-type -> content_type), as the trace format has keys. */
export function key(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_") || "_";
}

/** Whether a secret goes under the name: x-api-key, csrftoken, sessionid, password. */
export function sensitive(name: string): boolean {
  return SENSITIVE.test(name.replaceAll("-", "_"));
}

/** A header's value as one string: several values joined, as Node joins them. */
export function headerValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

function headers(prefix: string, entries: Iterable<[string, unknown]>): Attrs {
  const found: Attrs = {};
  for (const [name, raw] of entries) {
    const value = headerValue(raw);
    if (!value) continue;
    const lowered = name.toLowerCase();
    const attr = `${prefix}${key(lowered)}`;
    if (ALWAYS_MASKED.has(lowered) || sensitive(lowered)) found[attr] = MASK;
    else found[attr] = attr in found ? `${found[attr]}, ${value}` : value;
  }
  return found;
}

/** http.request.header.<name>, the name as a key; Cookie is read as cookies instead. */
export function requestHeaders(entries: Iterable<[string, unknown]>): Attrs {
  return headers(
    "http.request.header.",
    [...entries].filter(([name]) => name.toLowerCase() !== "cookie"),
  );
}

/** http.response.header.<name>: several values joined, Set-Cookie masked. */
export function responseHeaders(entries: Iterable<[string, unknown]>): Attrs {
  return headers("http.response.header.", entries);
}

/** Percent-encoded but for the characters `safe` keeps; a space as `+` when `plus`. */
function quote(text: string, safe: RegExp, plus = false): string {
  let out = "";
  for (const char of text) {
    if (plus && char === " ") out += "+";
    else if (safe.test(char)) out += char;
    else for (const byte of Buffer.from(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** url.query: the query string, the values of sensitive parameters masked. */
export function query(search: string): Attrs {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return {};
  const pairs = [...new URLSearchParams(raw)].map(
    ([name, value]) => `${quote(name, QUERY_SAFE, true)}=${quote(sensitive(name) ? MASK : value, QUERY_SAFE, true)}`,
  );
  return { "url.query": pairs.join("&") };
}

/** The Cookie header's cookies by name, as they came. */
export function parseCookies(header: string): [string, string][] {
  const found: [string, string][] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    if (at >= 0 && name) found.push([name, part.slice(at + 1).trim()]);
  }
  return found;
}

/** http.request.cookie.<name>, from the Cookie header; a session id or a CSRF token masked. */
export function cookies(header: string): Attrs {
  return Object.fromEntries(
    parseCookies(header).map(([name, value]) => [`http.request.cookie.${key(name)}`, sensitive(name) ? MASK : value]),
  );
}

/** The request's headers by lower-case name, from Node's IncomingMessage or a fetch Request. */
export type RequestHeaders = Record<string, string | string[] | undefined>;

/** What the request carried before the app read it: its headers, query and cookies. */
export function requestAttrs(requested: RequestHeaders, search: string): Attrs {
  return {
    ...requestHeaders(Object.entries(requested)),
    ...query(search),
    ...cookies(headerValue(requested.cookie) ?? ""),
  };
}

/** The query string of a request's URL (/books?page=2 -> ?page=2). */
export function searchOf(url: string): string {
  const at = url.indexOf("?");
  return at < 0 ? "" : url.slice(at);
}

function cut(text: string): Attrs {
  if (text.length <= MAX_BODY) return { "http.request.body": text };
  return { "http.request.body": text.slice(0, MAX_BODY), "http.request.body.truncated": true };
}

/** A JSON value with the values under sensitive keys masked, at any depth. */
export function masked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(masked);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, sensitive(name) ? MASK : masked(item)]),
    );
  }
  return value;
}

/** A form's fields as they would have been sent, sensitive values masked, then its files by name and size. */
function formText(fields: Iterable<[string, unknown]>, files: [string, string, number][] = []): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of fields) {
    if (sensitive(name)) pairs.push([name, MASK]);
    else if (Array.isArray(value)) for (const item of value) pairs.push([name, plain(item)]);
    else pairs.push([name, plain(value)]);
  }
  for (const [field, name, size] of files) pairs.push([field, `<file ${name}, ${size} bytes>`]);
  return pairs.map(([name, value]) => `${quote(name, READABLE)}=${quote(value, READABLE)}`).join("&");
}

/** A form's value as text: a nested one (qs's `a[b]=c`) as JSON, its secrets masked. */
function plain(value: unknown): string {
  return value !== null && typeof value === "object" ? JSON.stringify(masked(value)) : String(value ?? "");
}

function kindOf(contentType: string): string {
  return (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function isJson(kind: string): boolean {
  return kind === "application/json" || kind.endsWith("+json");
}

function isForm(kind: string): boolean {
  return kind === "application/x-www-form-urlencoded" || kind === "multipart/form-data";
}

/** A body read as text (a text or raw parser's): JSON and forms with secrets masked, text as it is, binary not. */
function textBody(contentType: string, text: string): Attrs {
  const kind = kindOf(contentType);
  if (!text) return {};
  if (isJson(kind)) {
    try {
      return cut(JSON.stringify(masked(JSON.parse(text))));
    } catch {
      return cut(text);
    }
  }
  if (kind === "application/x-www-form-urlencoded") return cut(formText(new URLSearchParams(text)));
  if (kind.startsWith("text/") || kind === "application/xml" || kind === "application/graphql") return cut(text);
  return {};
}

/** A file an upload middleware (multer) read: its field, file name and size. */
interface Upload {
  fieldname?: unknown;
  originalname?: unknown;
  size?: unknown;
}

function uploads(file: unknown, files: unknown): [string, string, number][] {
  const all: unknown[] = [];
  if (file) all.push(file);
  if (Array.isArray(files)) all.push(...files);
  else if (files && typeof files === "object") for (const list of Object.values(files)) all.push(...[list].flat());
  return all
    .filter((item): item is Upload => item !== null && typeof item === "object")
    .map((item) => [String(item.fieldname ?? ""), String(item.originalname ?? ""), Number(item.size ?? 0)]);
}

/** What a request's body parser left on it: `req.body`, and `req.file`/`req.files` of an upload. */
export interface ParsedBody {
  contentType: string;
  body: unknown;
  file?: unknown;
  files?: unknown;
}

/**
 * http.request.body from what the app's body parser read: JSON and forms with secrets masked, text as it is, an
 * upload's files by name and size. Nothing when no parser read it.
 */
export function parsedBody({ contentType, body, file, files }: ParsedBody): Attrs {
  const kind = kindOf(contentType);
  const sent = uploads(file, files);
  if (typeof body === "string") return textBody(contentType, body);
  if (body instanceof Uint8Array) return textBody(contentType, Buffer.from(body).toString("utf8"));
  if (body === undefined || body === null) return sent.length > 0 ? cut(formText([], sent)) : {};
  if (typeof body !== "object") return cut(JSON.stringify(body));
  if (isForm(kind)) {
    const text = formText(Object.entries(body), sent);
    return text ? cut(text) : {};
  }
  return cut(JSON.stringify(masked(body)));
}

/** Whether a request came with a body: one declared by its size, or sent in chunks. */
export function hasBody(requested: RequestHeaders): boolean {
  const length = Number(headerValue(requested["content-length"]) ?? 0);
  return length > 0 || (headerValue(requested["transfer-encoding"]) ?? "").toLowerCase().includes("chunked");
}

/**
 * The requests that answered a page's navigation with a redirect, by id, on the way to the page the widget will see:
 * its panel lists them before that page (a form's POST, then the page it redirected to).
 */
export const REDIRECTS = "tracepanel_redirect";
/** How many redirects in a row are kept: a loop of them doesn't grow the cookie without end. */
const MAX_REDIRECTS = 5;

/** Whether the browser asked for a page to show (a link, a form): not fetch() or an image. */
export function navigated(requested: RequestHeaders): boolean {
  const mode = headerValue(requested["sec-fetch-mode"]);
  return mode !== undefined ? mode === "navigate" : (headerValue(requested.accept) ?? "").includes("text/html");
}

/** The Set-Cookie naming this request too, for a redirect that answers a page's navigation; undefined otherwise. */
export function redirectCookie(id: string, status: number, requested: RequestHeaders): string | undefined {
  if (status < 300 || status >= 400 || !navigated(requested)) return undefined;
  const sent = parseCookies(headerValue(requested.cookie) ?? "").find(([name]) => name === REDIRECTS)?.[1] ?? "";
  let before: string[];
  try {
    before = decodeURIComponent(sent).split(",").filter(Boolean);
  } catch {
    before = [];
  }
  const value = encodeURIComponent([...before, id].slice(-MAX_REDIRECTS).join(","));
  return `${REDIRECTS}=${value}; Max-Age=30; Path=/; SameSite=Lax`;
}
