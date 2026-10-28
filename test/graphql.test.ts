// GraphQL Yoga (`app.use(yoga)` on Express, its own adapter writing the response) and Apollo Server (Express 5's
// integration), each with Tracepanel's plugin: the request is named after its operation, the operation a span with
// its phases, the app's resolvers spans with what they do under them. An exception a resolver throws is the trace's
// error though the client gets a 200; a GraphQL error the app answers with, or one of the client's (syntax,
// validation), is not. The variables are in the body, their secrets masked.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import express from "express";
import { createSchema, createYoga } from "graphql-yoga";
import { afterAll, describe, expect, test } from "vitest";
import { tracepanel } from "../src/express.js";
import { tracepanelApolloPlugin, tracepanelYogaPlugin } from "../src/graphql.js";
import type { Trace } from "../src/model.js";
import { resolvers, typeDefs } from "./app/library.js";
import { line, traceOf, tree } from "./traced.js";

const ORIGIN = "http://127.0.0.1:5173";

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql` };
}

// Yoga's own CORS, its own body parsing, its own writeHead().
const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  plugins: [tracepanelYogaPlugin()],
  logging: false,
});
const yogaApp = express();
yogaApp.use(tracepanel());
yogaApp.use(yoga.graphqlEndpoint, yoga);
const yogaServer = await listen(yogaApp);

const apollo = new ApolloServer({ typeDefs, resolvers, plugins: [tracepanelApolloPlugin()] });
await apollo.start();
const apolloApp = express();
apolloApp.use(tracepanel());
apolloApp.use("/graphql", express.json(), expressMiddleware(apollo));
const apolloServer = await listen(apolloApp);

afterAll(async () => {
  yogaServer.server.close();
  apolloServer.server.close();
  await apollo.stop();
});

function post(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

/** The trace's GraphQL attributes and what it was named. */
function operation(trace: Trace): Record<string, unknown> {
  return {
    name: trace.name,
    status: trace.status,
    ...Object.fromEntries(Object.entries(trace.attrs).filter(([key]) => key.startsWith("graphql."))),
  };
}

const BOOKS = "query Books { books { title author { name } } }";
const FIND_BOOK = `${line("app/books.ts", "find book")} in findBook`;

describe.each([
  // Yoga answers CORS itself; this Apollo app doesn't.
  { server: "GraphQL Yoga", library: "graphql-yoga", url: yogaServer.url, invalid: 200, cors: true },
  { server: "Apollo Server", library: "apollo-server", url: apolloServer.url, invalid: 400, cors: false },
])("$server", ({ library, url, invalid, cors }) => {
  test("the operation names the request; its phases and the app's resolvers are spans, their calls under them", async () => {
    const response = await post(url, { query: BOOKS, operationName: "Books" });
    const result = await traceOf(response);

    expect([response.status, await response.json()]).toEqual([
      200,
      {
        data: {
          books: [
            { title: "Dune", author: { name: "an author" } },
            { title: "Emma", author: { name: "an author" } },
          ],
        },
      },
    ]);

    // The badge finds the trace by its id, and the widget shows the operation.
    expect({
      id: response.headers.get("tracepanel-id"),
      name: response.headers.get("tracepanel-name"),
      expose: response.headers.get("access-control-expose-headers"),
    }).toEqual({
      id: result.id,
      name: "GraphQL query Books",
      expose: cors ? "Tracepanel-Id, Tracepanel-Name, Tracepanel-Url, Server-Timing" : null,
    });

    expect(operation(result)).toEqual({
      name: "GraphQL query Books",
      status: "ok",
      "graphql.operation": "query Books",
      "graphql.operation.type": "query",
      "graphql.operation.name": "Books",
      "graphql.document": BOOKS,
      "graphql.errors": 0,
      "graphql.library": library,
    });

    expect(result.attrs["http.request.body"]).toBe(JSON.stringify({ query: BOOKS, operationName: "Books" }));

    expect(
      tree(
        result,
        "graphql.operation.type",
        "graphql.operation.name",
        "graphql.document",
        "graphql.errors",
        "graphql.library",
        "graphql.field",
        "graphql.path",
        "code.function",
        "code.origin",
      ),
    ).toEqual([
      {
        kind: "http",
        name: "GraphQL query Books",
        children: [
          {
            kind: "graphql",
            name: "query Books",
            attrs: {
              "graphql.operation.type": "query",
              "graphql.operation.name": "Books",
              "graphql.document": BOOKS,
              "graphql.errors": 0,
              "graphql.library": library,
            },
            children: [
              { kind: "graphql", name: "parse" },
              { kind: "graphql", name: "validate" },
              {
                kind: "function",
                name: "Query.books",
                attrs: { "graphql.field": "Query.books", "graphql.path": "books", "code.function": "Query.books" },
              },
              // Each book's author: its query under it.
              ...["books.0.author", "books.1.author"].map((path) => ({
                kind: "function",
                name: "Book.author",
                attrs: { "graphql.field": "Book.author", "graphql.path": path, "code.function": "Book.author" },
                children: [{ kind: "sql", name: "SELECT books", attrs: { "code.origin": FIND_BOOK } }],
              })),
            ],
          },
        ],
      },
    ]);
  });

  test("an unnamed operation is named by what it asks for", async () => {
    const result = await traceOf(await post(url, { query: "{ books { title } authors { name } }" }));

    expect(operation(result)).toEqual({
      name: "GraphQL query { books, authors }",
      status: "ok",
      "graphql.operation": "query { books, authors }",
      "graphql.operation.type": "query",
      "graphql.operation.name": null,
      "graphql.document": "{ books { title } authors { name } }",
      "graphql.errors": 0,
      "graphql.library": library,
    });
  });

  test("a resolver's exception is the trace's error, on its span, though the client gets a 200", async () => {
    const response = await post(url, { query: "query Report { broken }" });
    const result = await traceOf(response);
    const resolver = result.spans.find((span) => span.name === "Query.broken");

    expect([response.status, (await response.json()).data]).toEqual([200, { broken: null }]);

    expect(operation(result)).toEqual({
      name: "GraphQL query Report",
      status: "error",
      "graphql.operation": "query Report",
      "graphql.operation.type": "query",
      "graphql.operation.name": "Report",
      "graphql.document": "query Report { broken }",
      "graphql.errors": 1,
      "graphql.library": library,
    });

    expect(resolver?.status).toBe("error");

    expect(
      result.errors.map(({ frames, ...error }) => ({ ...error, frames: frames.filter((frame) => frame.in_app) })),
    ).toEqual([
      {
        span_id: resolver?.id,
        time: expect.any(Number),
        type: "Error",
        message: "the reporting service is down",
        handled: false,
        frames: [
          {
            filename: "test/app/library.ts",
            module: "",
            function: "broken",
            lineno: Number(line("app/library.ts", "broken resolver").split(":")[1]),
            in_app: true,
            context_start: expect.any(Number),
            context: expect.arrayContaining([expect.stringContaining("the reporting service is down")]),
            locals: {},
          },
        ],
        chain: [],
      },
    ]);
  });

  test("a GraphQL error a resolver answers with is not an error of the app's", async () => {
    const response = await post(url, { query: "query Book { book(id: 9) { title } }" });
    const result = await traceOf(response);

    expect([response.status, (await response.json()).errors[0].message]).toEqual([200, "no book 9"]);

    expect([result.status, result.errors, result.attrs["graphql.errors"]]).toEqual(["ok", [], 1]);
  });

  test("an invalid document keeps its operation's name; one that didn't parse is a syntax error; neither is an error", async () => {
    const typo = await post(url, { query: "query Typo { bokks { id } }" });
    const unparsed = await post(url, { query: "query Team {", operationName: "Team" });
    const invalidTrace = await traceOf(typo);
    const unparsedTrace = await traceOf(unparsed);

    expect([typo.status, unparsed.status]).toEqual([invalid, invalid]);

    expect([operation(invalidTrace), invalidTrace.errors]).toEqual([
      {
        name: "GraphQL query Typo",
        status: "ok",
        "graphql.operation": "query Typo",
        "graphql.operation.type": "query",
        "graphql.operation.name": "Typo",
        "graphql.document": "query Typo { bokks { id } }",
        "graphql.errors": 1,
        "graphql.library": library,
      },
      [],
    ]);

    expect([operation(unparsedTrace), unparsedTrace.errors]).toEqual([
      {
        name: "GraphQL syntax error",
        status: "ok",
        "graphql.operation": "syntax error",
        "graphql.operation.type": null,
        "graphql.operation.name": null,
        "graphql.document": "query Team {",
        "graphql.errors": 1,
        "graphql.library": library,
      },
      [],
    ]);

    expect(tree(unparsedTrace)).toEqual([
      {
        kind: "http",
        name: "GraphQL syntax error",
        children: [{ kind: "graphql", name: "syntax error", children: [{ kind: "graphql", name: "parse" }] }],
      },
    ]);
  });

  test("the variables are in the body, their secrets masked", async () => {
    const query = "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) }";
    const response = await post(url, { query, variables: { email: "ann@example.com", password: "hunter2" } });
    const result = await traceOf(response);

    expect([await response.json(), result.name, result.attrs["http.request.body"]]).toEqual([
      { data: { login: true } },
      "GraphQL mutation Login",
      JSON.stringify({ query, variables: { email: "ann@example.com", password: "********" } }),
    ]);
  });
});
