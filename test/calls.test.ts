import { describe, expect, it } from "vitest";
import { httpCall, mongoCall, mongoStatement, redisCall, safeUrl } from "../src/calls.js";
import { exposedHeaders } from "../src/widget.js";

describe("calls to other systems", () => {
  it("keeps no credentials or secret values in a URL", () => {
    expect(safeUrl("https://ann:hunter2@api.example.com/v1/users?token=abc&page=2")).toBe(
      "https://api.example.com/v1/users?token=********&page=2",
    );
  });

  it("names an outgoing HTTP call by method, host and path", () => {
    const call = httpCall({
      "http.request.method": "get",
      "url.full": "http://127.0.0.1:8062/ping?api_key=k",
      "http.response.status_code": 200,
    });

    expect(call).toEqual({
      name: "GET 127.0.0.1/ping",
      attrs: {
        "http.request.method": "GET",
        "url.full": "http://127.0.0.1:8062/ping?api_key=********",
        "url.scheme": "http",
        "server.address": "127.0.0.1",
        "server.port": 8062,
        "http.response.status_code": 200,
      },
    });
  });

  it("names a Redis command by its key", () => {
    const call = redisCall(
      { "db.system.name": "redis", "db.query.text": "get post:42:summary", "server.address": "localhost" },
      "get",
    );

    expect(call).toEqual({
      name: "GET post:42:summary",
      attrs: {
        "db.system": "redis",
        "db.operation": "GET",
        "redis.key": "post:42:summary",
        "redis.alias": "redis",
        "server.address": "localhost",
        "server.port": null,
      },
    });
  });

  it("keeps a MongoDB command's shape, and its values only as a hash", () => {
    const find = (id: number) =>
      mongoCall(
        {
          "db.system": "mongodb",
          "db.operation": "find",
          "db.mongodb.collection": "brands",
          "db.statement": JSON.stringify({ find: "brands", filter: { _id: id }, lsid: { id: "x" } }),
        },
        "mongodb.find",
      );

    expect(find(1).name).toBe("find brands");
    expect(find(1).attrs["db.statement"]).toBe('{"find":"brands","filter":{"_id":"?"}}');

    expect(find(1).attrs["db.params_hash"]).toBe(find(1).attrs["db.params_hash"]);
    expect(find(1).attrs["db.params_hash"]).not.toBe(find(2).attrs["db.params_hash"]);
  });

  it("writes the sort the driver made a Map of as the app wrote it", () => {
    const command = {
      find: "questions",
      filter: { product: 7 },
      sort: new Map([["asked", -1]]),
      limit: 20,
    };

    expect(mongoStatement(command)).toBe('{"find":"questions","filter":{"product":7},"sort":{"asked":-1},"limit":20}');

    expect(
      mongoCall(
        { "db.system": "mongodb", "db.operation": "find", "db.statement": mongoStatement(command) },
        "mongodb.find",
      ).attrs["db.statement"],
    ).toBe('{"find":"questions","filter":{"product":"?"},"sort":{"asked":-1},"limit":20}');
  });
});

describe("headers for other origins", () => {
  it("adds the trace's headers to a CORS response's exposed ones", () => {
    expect(exposedHeaders("http://localhost:5173", "X-Total")).toBe(
      "X-Total, Tracepanel-Id, Tracepanel-Name, Tracepanel-Url, Server-Timing",
    );
  });

  it("leaves a response that isn't CORS alone", () => {
    expect(exposedHeaders(undefined, undefined)).toBeUndefined();
  });
});
