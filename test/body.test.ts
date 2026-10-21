// A request's body as the app reads it from the stream (Next.js, Nuxt, Bun.serve): the tap keeps the start of the
// pieces passing to the app, never more than MAX_BODY of them, and reads a multipart form as it passes, its files
// counted, never kept.
import { expect, test } from "vitest";
import { BodyTap } from "../src/body.js";
import { MAX_BODY } from "../src/request.js";

const BOUNDARY = "----form7MA4YWxk";
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;

/** The body through a tap, in pieces of `size` bytes, read to its end or not. */
function tapped(contentType: string, body: string | Buffer, size = 7, ended = true): BodyTap {
  const tap = new BodyTap(contentType);
  const bytes = Buffer.from(body);
  for (let at = 0; at < bytes.length; at += size) tap.feed(bytes.subarray(at, at + size));
  if (ended) tap.end();
  return tap;
}

/** A multipart form as a browser sends it. */
function multipart(parts: { name: string; filename?: string; type?: string; value: string | Buffer }[]): Buffer {
  const pieces: Buffer[] = [];
  for (const part of parts) {
    const file = part.filename === undefined ? "" : `; filename="${part.filename}"`;
    const type = part.type ? `\r\nContent-Type: ${part.type}` : "";
    pieces.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"${file}${type}\r\n\r\n`),
    );
    pieces.push(Buffer.from(part.value), Buffer.from("\r\n"));
  }
  pieces.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(pieces);
}

test("JSON and a form as the app read them, secrets masked; text as it is; binary not recorded", () => {
  expect(tapped("application/json", '{"email":"a@b.c","password":"p","card":{"token":"t"}}').attrs()).toEqual({
    "http.request.body": '{"email":"a@b.c","password":"********","card":{"token":"********"}}',
  });

  expect(tapped("application/x-www-form-urlencoded", "email=a%40b.c&password=p&q=war+and+peace").attrs()).toEqual({
    "http.request.body": "email=a@b.c&password=********&q=war and peace",
  });

  expect(tapped("text/plain; charset=utf-8", "héllo").attrs()).toEqual({ "http.request.body": "héllo" });

  expect([
    tapped("application/octet-stream", Buffer.from([0, 1, 2])).attrs(),
    tapped("application/json", "").attrs(),
    new BodyTap("application/json").attrs(),
  ]).toEqual([{}, {}, {}]);
});

test("a multipart form's fields and files by name and size, read across pieces of any size, contents never kept", () => {
  const body = multipart([
    { name: "title", value: "Dune" },
    { name: "password", value: "p" },
    { name: "cover", filename: "dune.png", type: "image/png", value: Buffer.alloc(3000, 0xff) },
    { name: "notes", value: "line one\r\nline two" },
  ]);
  const expected = {
    "http.request.body": "title=Dune&password=********&notes=line one%0D%0Aline two&cover=<file dune.png, 3000 bytes>",
  };

  for (const size of [1, 2, 7, 64, body.length]) expect(tapped(MULTIPART, body, size).attrs()).toEqual(expected);
});

test("a multipart upload past MAX_BODY: its fields and files all the same, the file counted as it passes", () => {
  const upload = multipart([
    { name: "album", value: "summer" },
    { name: "photo", filename: "beach.jpg", value: Buffer.alloc(5 * MAX_BODY, 0x2d) },
  ]);
  const tap = tapped(MULTIPART, upload, 1000);

  expect(tap.attrs()).toEqual({ "http.request.body": `album=summer&photo=<file beach.jpg, ${5 * MAX_BODY} bytes>` });
});

test("a multipart form's field values past MAX_BODY in all: what fits, and it says the form was cut", () => {
  const body = multipart([
    { name: "a", value: "x".repeat(2 * MAX_BODY) },
    { name: "b", value: "y" },
  ]);

  expect(tapped(MULTIPART, body, 4096).attrs()).toEqual({
    "http.request.body": `a=${"x".repeat(MAX_BODY - 2)}`,
    "http.request.body.truncated": true,
  });
});

test("a multipart form not read to its end, or without its boundary, is not recorded", () => {
  const body = multipart([{ name: "title", value: "Dune" }]);

  expect([
    tapped(MULTIPART, body.subarray(0, 40), 7, false).attrs(),
    tapped("multipart/form-data", body).attrs(),
  ]).toEqual([{}, {}]);
});

test("text past MAX_BODY is cut and says so; JSON or a form past it, or read in part, is not recorded", () => {
  expect(tapped("text/plain", "x".repeat(MAX_BODY * 3), 5000).attrs()).toEqual({
    "http.request.body": "x".repeat(MAX_BODY),
    "http.request.body.truncated": true,
  });

  expect(tapped("text/plain", "é".repeat(MAX_BODY), 5000).attrs()).toEqual({
    "http.request.body": expect.stringMatching(/^é+/),
    "http.request.body.truncated": true,
  });

  expect([
    tapped("application/json", JSON.stringify({ text: "x".repeat(MAX_BODY) }), 5000).attrs(),
    tapped("application/x-www-form-urlencoded", `a=${"x".repeat(MAX_BODY)}`, 5000).attrs(),
    tapped("application/json", '{"a":1}', 3, false).attrs(),
  ]).toEqual([{}, {}, {}]);
});

test("the tap keeps no more than MAX_BODY and a byte of a body, however large", () => {
  const tap = tapped("text/plain", Buffer.alloc(10 * MAX_BODY, 0x61), 3000);
  const kept = (tap as unknown as { kept: Buffer[] }).kept;

  expect(kept.reduce((size, piece) => size + piece.length, 0)).toBe(MAX_BODY + 1);
});

test("pieces after the body's end (Next.js reading a middleware's copy again) are not counted twice", () => {
  const tap = tapped("application/json", '{"a":1}');
  tap.feed(Buffer.from('{"a":1}'));

  expect(tap.attrs()).toEqual({ "http.request.body": '{"a":1}' });
});
