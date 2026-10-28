// A library's GraphQL schema for the GraphQL servers' tests: its resolvers are the app's code, each book's author a
// query of its own (an N+1); one resolver fails, another answers with a GraphQL error of its own.

import { createRequire } from "node:module";
import { findBook } from "./books.js";

// graphql as the servers load it, through Node: under Vitest, `import "graphql"` here would load its other build,
// whose errors Yoga doesn't take for GraphQL's, and masks.
const { GraphQLError } = createRequire(import.meta.url)("graphql") as typeof import("graphql");

export const typeDefs = /* GraphQL */ `
  type Author {
    id: ID!
    name: String!
  }

  type Book {
    id: ID!
    title: String!
    author: Author!
  }

  type Query {
    books: [Book!]!
    authors: [Author!]!
    broken: String
    book(id: ID!): Book
  }

  type Mutation {
    login(email: String!, password: String!): Boolean!
  }
`;

const BOOKS = [
  { id: "1", title: "Dune", authorId: "7" },
  { id: "2", title: "Emma", authorId: "8" },
];

export const resolvers = {
  Query: {
    books: async () => BOOKS,
    authors: () => [{ id: "7", name: "Frank Herbert" }],
    broken: () => {
      throw new Error("the reporting service is down"); // broken resolver
    },
    book: (_: unknown, { id }: { id: string }) => {
      throw new GraphQLError(`no book ${id}`, { extensions: { code: "NOT_FOUND" } });
    },
  },
  Book: {
    // One query per book.
    author: async (book: { authorId: string }) => ({ ...findBook(book.authorId), name: "an author" }),
  },
  Mutation: {
    login: () => true,
  },
};
