// The widget's script put into an HTML page streamed in pieces, right after its <head> (or <body>) opens.
import { expect, test } from "vitest";
import { Stream } from "../src/widget.js";

const TAG = "<script></script>";

function through(...pieces: string[]): string[] {
  const script = new Stream(TAG);
  return [...pieces.map((piece) => script.feed(Buffer.from(piece)).toString()), script.end().toString()];
}

test("the script goes right after the head opens", () => {
  expect(through("<!doctype html><html><head><title>t</title>", "</head><body>x</body>")).toEqual([
    "<!doctype html><html><head><script></script><title>t</title>",
    "</head><body>x</body>",
    "",
  ]);
});

test("a tag split between pieces is held until it ends", () => {
  expect(through("<html><he", 'ad class="x">', "<body>")).toEqual([
    "<html>",
    '<head class="x"><script></script>',
    "<body>",
    "",
  ]);
});

test("without a head the script goes after the body opens", () => {
  expect(through("<html><body>", "hi</body>").join("")).toBe("<html><body><script></script>hi</body>");
});

test("a header element is not the head", () => {
  expect(through("<header>a</header><head>").join("")).toBe("<header>a</header><head><script></script>");
});

test("a page without either far enough in passes as it came", () => {
  const pieces = [`<p>${"x".repeat(40_000)}`, `<p>${"y".repeat(40_000)}`, "<head>"];

  expect(through(...pieces).join("")).toBe(pieces.join(""));
});

test("what is held at the end goes out then", () => {
  expect(through("text <unfinished")).toEqual(["text ", "<unfinished"]);
});

test("a character cut between pieces comes out whole", () => {
  const page = Buffer.from("<head><title>café</title>");
  const script = new Stream(TAG);
  const cut = page.indexOf("é") + 1;

  const out = Buffer.concat([script.feed(page.subarray(0, cut)), script.feed(page.subarray(cut)), script.end()]);

  expect(out.toString()).toBe("<head><script></script><title>café</title>");
});
