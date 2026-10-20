// What a request carried, as its trace's attributes: the values under sensitive names masked, a body only as the app's
// parser read it and cut at MAX_BODY; the redirect cookie of a page's navigation; and the hello that says they are kept.
import { expect, test } from "vitest";
import { hello } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import {
  cookies,
  MAX_BODY,
  navigated,
  parsedBody,
  query,
  redirectCookie,
  requestAttrs,
  responseHeaders,
} from "../src/request.js";

test("headers by their names as keys, secrets masked; the Cookie header as cookies, Set-Cookie always masked", () => {
  const attrs = requestAttrs(
    {
      "content-type": "application/json",
      "x-csrf-token": "t",
      authorization: "Bearer t",
      "x-forwarded-for": ["10.0.0.1", "10.0.0.2"],
      cookie: "theme=dark; sessionid=abc; broken; =nameless",
      "x-empty": "",
    },
    "?q=dune&password=p&empty=",
  );

  expect(attrs).toEqual({
    "http.request.header.content_type": "application/json",
    "http.request.header.x_csrf_token": "********",
    "http.request.header.authorization": "********",
    "http.request.header.x_forwarded_for": "10.0.0.1, 10.0.0.2",
    "url.query": "q=dune&password=********&empty=",
    "http.request.cookie.theme": "dark",
    "http.request.cookie.sessionid": "********",
  });

  expect(
    responseHeaders([
      ["Set-Cookie", ["a=1", "b=2"]],
      ["Content-Length", 12],
      ["Cache-Control", "no-store"],
    ]),
  ).toEqual({
    "http.response.header.set_cookie": "********",
    "http.response.header.content_length": "12",
    "http.response.header.cache_control": "no-store",
  });
});

test("a query is encoded as a form's, its spaces as +, and none is no attribute", () => {
  expect(query("?q=war+and+peace&path=/a:b&n=%C3%A9&access_token=x")).toEqual({
    "url.query": "q=war+and+peace&path=/a:b&n=%C3%A9&access_token=********",
  });

  expect([query(""), query("?"), cookies("")]).toEqual([{}, {}, {}]);
});

test("a form's body as it was sent, readable: secrets masked, repeated fields kept, an upload's files by name and size", () => {
  const form = "application/x-www-form-urlencoded";

  expect(parsedBody({ contentType: form, body: { email: "a@b.c", password: "p", tags: ["x", "y z"] } })).toEqual({
    "http.request.body": "email=a@b.c&password=********&tags=x&tags=y z",
  });

  expect(
    parsedBody({
      contentType: "multipart/form-data; boundary=x",
      body: { title: "Dune", meta: { year: 1965, secret: "s" } },
      files: { cover: [{ fieldname: "cover", originalname: "dune.png", size: 2048 }] },
    }),
  ).toEqual({
    "http.request.body":
      "title=Dune&meta=%7B%22year%22:1965,%22secret%22:%22********%22%7D&cover=<file dune.png, 2048 bytes>",
  });

  expect(
    parsedBody({
      contentType: "multipart/form-data",
      body: undefined,
      file: { fieldname: "avatar", originalname: "me.jpg", size: 10 },
    }),
  ).toEqual({ "http.request.body": "avatar=<file me.jpg, 10 bytes>" });
});

test("a body read as text or bytes: JSON and forms masked, text as it is, binary and nothing read not recorded", () => {
  expect(parsedBody({ contentType: "application/vnd.api+json", body: Buffer.from('[{"token":"t","id":1}]') })).toEqual({
    "http.request.body": '[{"token":"********","id":1}]',
  });

  expect(parsedBody({ contentType: "application/json", body: "{not json" })).toEqual({
    "http.request.body": "{not json",
  });

  expect(parsedBody({ contentType: "application/x-www-form-urlencoded", body: "a=1&api_key=k" })).toEqual({
    "http.request.body": "a=1&api_key=********",
  });

  expect(parsedBody({ contentType: "text/plain; charset=utf-8", body: "hello" })).toEqual({
    "http.request.body": "hello",
  });

  expect([
    parsedBody({ contentType: "application/octet-stream", body: Buffer.from([1, 2, 3]) }),
    parsedBody({ contentType: "application/json", body: undefined }),
    parsedBody({ contentType: "text/plain", body: "" }),
  ]).toEqual([{}, {}, {}]);
});

test("a body past MAX_BODY characters is cut there, and says so", () => {
  const long = "x".repeat(MAX_BODY + 10);

  expect(parsedBody({ contentType: "text/plain", body: long })).toEqual({
    "http.request.body": "x".repeat(MAX_BODY),
    "http.request.body.truncated": true,
  });

  expect(parsedBody({ contentType: "text/plain", body: "x".repeat(MAX_BODY) })).toEqual({
    "http.request.body": "x".repeat(MAX_BODY),
  });
});

test("a navigation is the browser going to a page: Sec-Fetch-Mode, or an Accept with HTML without it", () => {
  expect([
    navigated({ "sec-fetch-mode": "navigate" }),
    navigated({ "sec-fetch-mode": "cors", accept: "text/html" }),
    navigated({ accept: "text/html,application/xhtml+xml" }),
    navigated({ accept: "application/json" }),
    navigated({}),
  ]).toEqual([true, false, true, false, false]);
});

test("a redirect answering a navigation names its request after the ones before it, the last five", () => {
  const navigation = { "sec-fetch-mode": "navigate" };

  expect(redirectCookie("01A", 302, navigation)).toBe("tracepanel_redirect=01A; Max-Age=30; Path=/; SameSite=Lax");

  expect(
    redirectCookie("01F", 303, { ...navigation, cookie: "x=1; tracepanel_redirect=01A%2C01B%2C01C%2C01D%2C01E" }),
  ).toBe("tracepanel_redirect=01B%2C01C%2C01D%2C01E%2C01F; Max-Age=30; Path=/; SameSite=Lax");

  expect([
    redirectCookie("01A", 200, navigation),
    redirectCookie("01A", 404, navigation),
    redirectCookie("01A", 302, { "sec-fetch-mode": "cors" }),
  ]).toEqual([undefined, undefined, undefined]);
});

test("the hello says the app keeps what requests carried, unless TRACEPANEL_CAPTURE_REQUEST turns it off", () => {
  expect(hello(loadConfig({ TRACEPANEL_SERVICE: "shop" }))).toEqual({
    protocol: 1,
    max_traces: 2000,
    thresholds: expect.any(Object),
    service: "shop",
    capabilities: ["explain", "request", "profile"],
  });

  expect(hello(loadConfig({ TRACEPANEL_SERVICE: "shop", TRACEPANEL_CAPTURE_REQUEST: "0" }))).toEqual({
    protocol: 1,
    max_traces: 2000,
    thresholds: expect.any(Object),
    service: "shop",
    capabilities: ["explain", "profile"],
  });

  expect([
    loadConfig({}).captureRequest,
    loadConfig({ TRACEPANEL_CAPTURE_REQUEST: "off" }).captureRequest,
    loadConfig({ TRACEPANEL_CAPTURE_REQUEST: "1" }).captureRequest,
  ]).toEqual([true, false, true]);
});
