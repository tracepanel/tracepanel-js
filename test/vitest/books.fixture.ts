// Tests of the app in library.ts as a project writes them, under Tracepanel's Vitest plugin.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { maxQueries, testTrace } from "../../src/vitest.js";
import { booksJoined, booksOneByOne, countTwice, pool, seed, server } from "./library.js";

beforeAll(seed);
afterAll(() => pool.end());

test("an N+1 fails the test", async () => {
  expect(await booksOneByOne()).toHaveLength(4);
});

test("duplicate queries fail the test", async () => {
  expect(await countTwice()).toEqual([1, 1]);
});

test("one query passes", async () => {
  expect(await booksJoined()).toHaveLength(4);
  expect(testTrace().queries).toBe(1);
});

test("an N+1 the test allows passes", { meta: { tracepanel: { allow: ["n+1"] } } }, async () => {
  expect(await booksOneByOne()).toHaveLength(4);
});

describe("allowed in the suite", { meta: { tracepanel: { allow: "n+1" } } }, () => {
  test("an N+1 in a suite that allows it passes", async () => {
    await booksOneByOne();
  });

  test("the test's own maxQueries is over the suite's allow", { meta: { tracepanel: { maxQueries: 2 } } }, async () => {
    await booksOneByOne();
  });
});

test("maxQueries() fails the block that makes more", { meta: { tracepanel: { allow: ["n+1"] } } }, async () => {
  await maxQueries(1, () => booksJoined());
  await maxQueries(2, () => booksOneByOne());
});

test("an N+1 in a request the test made fails it", async () => {
  const app = await server();
  try {
    const answer = await fetch(`${app.url}/books`);
    expect(await answer.json()).toHaveLength(4);
    expect(testTrace().queries).toBe(5);
  } finally {
    await app.close();
  }
});

test("a test that fails on its own fails with its own error", async () => {
  await booksOneByOne();
  expect(1).toBe(2);
});

test("a misspelled kind fails the test", { meta: { tracepanel: { allow: ["n+2" as "n+1"] } } }, () => {});
