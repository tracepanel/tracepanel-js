// A GraphQL request's operation, from what it sends (the JSON body, a document, a GET's query string), on its trace
// whatever the answer: a server that answered before its GraphQL server ran (a 503, a gateway's refusal) or that never
// answered keeps the operation the request carried, and names the trace after it, as the agent names a stored one.
// Only the operation's type and name are recorded: with the body off, the body isn't.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, expect, test } from "vitest";
import { BodyTap } from "../src/body.js";
import { GRAPHQL_MAX, graphqlOperationOfBody, graphqlOperationOfQuery } from "../src/browser.js";
import { tracepanel } from "../src/express.js";
import type { Trace } from "../src/model.js";
import { tracepanel as runtime, send, traceOf, traceWhere } from "./traced.js";

// The rule the agent and its widget name a stored request by (the agent's schema/graphql-names.json).
const CASES: [string, string | null][] = [
  ['{"operationName":"Authors","query":"query Authors { authors { id name } }","variables":{}}', "query Authors"],
  ['{"query":"query Books { books { id title } }"}', "query Books"],
  [
    '{"query":"\\n  mutation AddReview($bookId: ID!) { addReview(bookId: $bookId) { id } }","variables":{"bookId":"1"}}',
    "mutation AddReview",
  ],
  ['{"query":"subscription OnReview{ reviewAdded { id } }"}', "subscription OnReview"],
  ['{"operationName":"Second","query":"query First { a } query Second { b }"}', "query Second"],
  ['{"operationName":"","query":"query _private_1 { a }"}', "query _private_1"],
  ['{"query":"{ books { id } }"}', null],
  ['{"query":"query { books { id } }"}', null],
  ['{"query":"queryBooks { books { id } }"}', null],
  ['{"query":"query 1Books { a }"}', null],
  ['{"query": 42}', null],
  ['[{"query":"query Books { books { id } }"}]', null],
  ['{"query":"query Books { books { id', null],
  ["month=10&query=query+Books", null],
];

test.each(CASES)("the body %s carries %s", (body, operation) => {
  const found = graphqlOperationOfBody(body, "application/json");

  expect(found ? `${found["graphql.operation.type"]} ${found["graphql.operation.name"]}` : null).toBe(operation);
});

test("a document sent as application/graphql, a GET's query string; a body past the limit is not read", () => {
  expect(graphqlOperationOfBody("query Books { books { id } }", "application/graphql; charset=utf-8")).toEqual({
    "graphql.operation.type": "query",
    "graphql.operation.name": "Books",
  });

  expect(graphqlOperationOfQuery(`?query=${encodeURIComponent("query Books { a }")}&operationName=Books`)).toEqual({
    "graphql.operation.type": "query",
    "graphql.operation.name": "Books",
  });
  expect(graphqlOperationOfQuery("?query=books&page=2")).toBeUndefined();

  const padded = JSON.stringify({ query: `query Books { a }${" ".repeat(GRAPHQL_MAX)}` });
  expect(graphqlOperationOfBody(padded, "application/json")).toBeUndefined();
});

test("a tapped body names its operation once it all passed, not from a part of it", () => {
  const body = Buffer.from(JSON.stringify({ query: "query Books { a }" }));
  const tap = new BodyTap("application/json");
  tap.feed(body.subarray(0, 10));

  expect(tap.operation()).toBeUndefined();

  tap.feed(body.subarray(10));
  tap.end();

  expect(tap.operation()).toEqual({ "graphql.operation.type": "query", "graphql.operation.name": "Books" });

  const cut = new BodyTap("application/json");
  cut.feed(Buffer.from(JSON.stringify({ query: `query Books { a }${" ".repeat(GRAPHQL_MAX)}` })));
  cut.end();

  expect(cut.operation()).toBeUndefined();
});

// A gateway in front of the GraphQL server: it answers 503 before the server reads the request; or the server reads
// it and fails, or drops it without an answer.
const app = express();
app.use(tracepanel());
app.use("/graphql", (req, res, next) => {
  if (req.headers["x-test"] === "unavailable") res.status(503).json({ errors: [{ message: "unavailable" }] });
  else next();
});
app.use("/graphql", express.json(), (req, res) => {
  if (req.headers["x-test"] === "drop") req.socket.destroy();
  else res.status(500).json({ errors: [{ message: "the GraphQL server failed" }] });
});
const server: Server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
const AUTHORS = JSON.stringify({ operationName: "Authors", query: "query Authors { authors { id name } }" });

afterAll(() => server.close());
afterEach(() => {
  runtime.config.captureRequest = true;
});

/** What a trace says of its request and its operation. */
function named(trace: Trace): Record<string, unknown> {
  const root = trace.spans.find((span) => span.parent_id === null);
  return {
    name: trace.name,
    root: root?.name,
    status: trace.status,
    statusCode: trace.attrs["http.status_code"],
    type: trace.attrs["graphql.operation.type"],
    operation: trace.attrs["graphql.operation.name"],
    body: trace.attrs["http.request.body"],
  };
}

test("a 503 before the GraphQL server read the body keeps the operation the request carried", async () => {
  const response = await send(URL, "POST", { "Content-Type": "application/json", "X-Test": "unavailable" }, AUTHORS);
  const trace = await traceOf(response);

  expect(response.status).toBe(503);

  expect(named(trace)).toEqual({
    name: "GraphQL query Authors",
    root: "GraphQL query Authors",
    status: "error",
    statusCode: 503,
    type: "query",
    operation: "Authors",
    // Nobody read the body: it is not recorded.
    body: undefined,
  });
});

test("with the body off, the operation is still recorded, the body not", async () => {
  runtime.config.captureRequest = false;
  const response = await send(URL, "POST", { "Content-Type": "application/json" }, AUTHORS);
  const trace = await traceOf(response);

  expect(named(trace)).toEqual({
    name: "GraphQL query Authors",
    root: "GraphQL query Authors",
    status: "error",
    statusCode: 500,
    type: "query",
    operation: "Authors",
    body: undefined,
  });

  // The widget gets the name with the answer, the body read by then.
  expect(response.headers["tracepanel-name"]).toBe("GraphQL query Authors");
});

test("a GET's query string names the operation; a request that got no answer keeps it too", async () => {
  const query = encodeURIComponent("query Books { books { id } }");
  const response = await send(`${URL}?query=${query}`, "GET", { "X-Test": "unavailable" });
  const trace = await traceOf(response);

  expect(named(trace)).toMatchObject({
    name: "GraphQL query Books",
    status: "error",
    type: "query",
    operation: "Books",
  });

  const mutation = JSON.stringify({ query: "mutation AddReview { addReview { id } }" });
  await send(URL, "POST", { "Content-Type": "application/json", "X-Test": "drop" }, mutation).catch(() => undefined);
  const dropped = await traceWhere((found) => found.attrs["graphql.operation.name"] === "AddReview");

  expect(named(dropped)).toMatchObject({
    name: "GraphQL mutation AddReview",
    type: "mutation",
    operation: "AddReview",
  });
});

test("a JSON body that is no GraphQL request names nothing", async () => {
  const response = await send(URL, "POST", { "Content-Type": "application/json", "X-Test": "unavailable" }, "{}");
  const trace = await traceOf(response);

  expect(named(trace)).toEqual({
    name: "POST /graphql",
    root: "POST /graphql",
    status: "error",
    statusCode: 503,
    type: undefined,
    operation: undefined,
    body: undefined,
  });
});
