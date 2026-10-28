// The AWS SDK's v3 clients against a local stand-in for AWS: each command the app sends is one span of the kind the
// agent analyzes it as (S3 a storage call, DynamoDB a datastore's command, SQS's SendMessage a message, any other an
// RPC call), with what the Python SDK records of boto3's calls.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { awsInstrumentation, spacedJson } from "../src/aws.js";
import { type Config, loadConfig } from "../src/config.js";
import type { Span, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (made) => sent.push(made) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

// The instrumentation hooks the SDK's modules as they load: before the clients are required.
const instrumentation = awsInstrumentation();
instrumentation.setTracerProvider(provider);
instrumentation.enable();
const require = createRequire(import.meta.url);
const s3 = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
const dynamodb = require("@aws-sdk/client-dynamodb") as typeof import("@aws-sdk/client-dynamodb");
const documents = require("@aws-sdk/lib-dynamodb") as typeof import("@aws-sdk/lib-dynamodb");
const sqs = require("@aws-sdk/client-sqs") as typeof import("@aws-sdk/client-sqs");
const secrets = require("@aws-sdk/client-secrets-manager") as typeof import("@aws-sdk/client-secrets-manager");

/** What the stand-in for AWS was asked: `PUT /media/avatars/1.png`, `DynamoDB_20120810.GetItem`. */
const asked: string[] = [];
/** Answers to fail with once, by what was asked: a throttled call, retried. */
const failOnce = new Set<string>();

function json(res: ServerResponse, status: number, body: unknown, type = "application/x-amz-json-1.0"): void {
  res.writeHead(status, { "Content-Type": type, "x-amzn-RequestId": "req-1" });
  res.end(JSON.stringify(body));
}

async function read(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const piece of req) body += piece;
  return body;
}

const server = createServer(async (req, res) => {
  const body = await read(req);
  const target = String(req.headers["x-amz-target"] ?? "");
  const call = target || `${req.method} ${req.url?.split("?")[0]}`;
  asked.push(call);
  if (failOnce.delete(call)) {
    json(res, 500, { __type: "com.amazonaws.dynamodb.v20120810#InternalServerError", message: "try again" });
    return;
  }
  if (call === "PUT /media/avatars/1.png") {
    res.writeHead(200, { ETag: '"abc"', "x-amz-request-id": "s3-req", "x-amz-id-2": "s3-host" });
    res.end();
  } else if (call === "GET /media/avatars/1.png") {
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": "5", "x-amz-request-id": "s3-req" });
    res.end("hello");
  } else if (call === "HEAD /media/avatars/2.png") {
    res.writeHead(404, { "x-amz-request-id": "s3-req" });
    res.end();
  } else if (target === "DynamoDB_20120810.GetItem") {
    json(res, 200, { Item: { id: { N: "1" }, name: { S: "Ann" } } });
  } else if (target === "DynamoDB_20120810.Query") {
    json(res, 200, { Count: 2, ScannedCount: 2, Items: [{ id: { N: "1" } }, { id: { N: "2" } }] });
  } else if (target === "DynamoDB_20120810.PutItem") {
    json(res, 400, {
      __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException",
      message: "The conditional request failed",
    });
  } else if (target === "AmazonSQS.SendMessage") {
    const message = JSON.parse(body) as { MessageBody: string };
    const md5 = createHash("md5").update(message.MessageBody).digest("hex");
    json(res, 200, { MessageId: "msg-1", MD5OfMessageBody: md5 });
  } else if (target === "secretsmanager.GetSecretValue") {
    json(res, 200, { Name: "db", SecretString: "hunter2" }, "application/x-amz-json-1.1");
  } else {
    res.writeHead(400);
    res.end();
  }
});

let endpoint = "";
const credentials = { accessKeyId: "test", secretAccessKey: "test" };

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  manager.disable();
});

beforeEach(() => {
  sent.length = 0;
  asked.length = 0;
});

/** The request's trace, with the calls `app` made inside it. */
async function request(app: () => Promise<unknown>): Promise<Trace> {
  const root = tracer.startSpan("GET", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "url.path": "/profile" },
  });
  await context.with(trace.setSpan(context.active(), root), async () => {
    try {
      await app();
    } catch {
      // The app answers a failed call itself.
    }
  });
  root.end();
  await new Promise((done) => setTimeout(done, 60));
  expect(sent).toHaveLength(1);
  return sent[0] as Trace;
}

function calls(made: Trace): Span[] {
  return made.spans.filter((span) => span.parent_id !== null);
}

const call = {
  id: expect.any(String),
  parent_id: expect.any(String),
  start: expect.any(Number),
  duration: expect.any(Number),
};

describe("S3", () => {
  const client = () => new s3.S3Client({ region: "eu-west-1", endpoint, credentials, forcePathStyle: true });

  it("is a storage call each: the bucket and key its path, the bytes it sent and got", async () => {
    const made = await request(async () => {
      await client().send(new s3.PutObjectCommand({ Bucket: "media", Key: "avatars/1.png", Body: "hello" }));
      await client().send(new s3.GetObjectCommand({ Bucket: "media", Key: "avatars/1.png" }));
    });

    expect(calls(made)).toEqual([
      {
        ...call,
        kind: "storage",
        name: "S3 PutObject media/avatars/1.png",
        status: "ok",
        attrs: {
          "rpc.system": "aws-api",
          "rpc.service": "S3",
          "rpc.method": "PutObject",
          "cloud.region": "eu-west-1",
          "http.response.status_code": 200,
          "storage.backend": "@aws-sdk/client-s3.S3",
          "storage.system": "s3",
          "storage.op": "PutObject",
          "storage.path": "media/avatars/1.png",
          "aws.s3.bucket": "media",
          "aws.s3.key": "avatars/1.png",
          "storage.bytes": 5,
          "aws.request_id": "s3-req",
          "aws.extended_request_id": "s3-host",
          "code.origin": null,
        },
      },
      {
        ...call,
        kind: "storage",
        name: "S3 GetObject media/avatars/1.png",
        status: "ok",
        attrs: {
          "rpc.system": "aws-api",
          "rpc.service": "S3",
          "rpc.method": "GetObject",
          "cloud.region": "eu-west-1",
          "http.response.status_code": 200,
          "storage.backend": "@aws-sdk/client-s3.S3",
          "storage.system": "s3",
          "storage.op": "GetObject",
          "storage.path": "media/avatars/1.png",
          "aws.s3.bucket": "media",
          "aws.s3.key": "avatars/1.png",
          "storage.bytes": 5,
          "aws.request_id": "s3-req",
          "code.origin": null,
        },
      },
    ]);
    // Its HTTP requests are the call's, not outgoing calls of their own.
    expect(asked).toEqual(["PUT /media/avatars/1.png", "GET /media/avatars/1.png"]);
  });

  it("is an error with AWS's code when it fails", async () => {
    const made = await request(() =>
      client().send(new s3.HeadObjectCommand({ Bucket: "media", Key: "avatars/2.png" })),
    );

    expect(calls(made)).toEqual([
      {
        ...call,
        kind: "storage",
        name: "S3 HeadObject media/avatars/2.png",
        status: "error",
        attrs: {
          "rpc.system": "aws-api",
          "rpc.service": "S3",
          "rpc.method": "HeadObject",
          "cloud.region": "eu-west-1",
          "http.response.status_code": 404,
          "error.type": "NotFound",
          "storage.backend": "@aws-sdk/client-s3.S3",
          "storage.system": "s3",
          "storage.op": "HeadObject",
          "storage.path": "media/avatars/2.png",
          "aws.s3.bucket": "media",
          "aws.s3.key": "avatars/2.png",
          "aws.request_id": "s3-req",
          "code.origin": null,
        },
      },
    ]);
  });
});

describe("DynamoDB", () => {
  const client = () => new dynamodb.DynamoDBClient({ region: "eu-west-1", endpoint, credentials });

  it("is a datastore command: its shape the statement, its values the parameters, the items it returned", async () => {
    const made = await request(async () => {
      await client().send(new dynamodb.GetItemCommand({ TableName: "users", Key: { id: { N: "1" } } }));
      await documents.DynamoDBDocumentClient.from(client()).send(
        new documents.QueryCommand({
          TableName: "users",
          IndexName: "by-team",
          KeyConditionExpression: "team = :team",
          ExpressionAttributeValues: { ":team": "core" },
        }),
      );
    });

    expect(calls(made)).toEqual([
      {
        ...call,
        kind: "dynamodb",
        name: "DynamoDB GetItem users",
        status: "ok",
        attrs: {
          "rpc.system": "aws-api",
          "rpc.service": "DynamoDB",
          "rpc.method": "GetItem",
          "cloud.region": "eu-west-1",
          "http.response.status_code": 200,
          "db.system": "dynamodb",
          "db.operation": "GetItem",
          "db.collection.name": "users",
          "aws.dynamodb.table_names": ["users"],
          "db.statement": '{"TableName": "users", "Key": {"id": "?"}}',
          "db.params_hash": expect.stringMatching(/^[0-9a-f]{12}$/),
          "db.params": ["1"],
          "db.response.returned_rows": 1,
          "aws.request_id": "req-1",
          "code.origin": null,
        },
      },
      {
        ...call,
        kind: "dynamodb",
        name: "DynamoDB Query users",
        status: "ok",
        attrs: {
          "rpc.system": "aws-api",
          "rpc.service": "DynamoDB",
          "rpc.method": "Query",
          // The Document client's commands leave the instrumentation without the client's region.
          "http.response.status_code": 200,
          "db.system": "dynamodb",
          "db.operation": "Query",
          "db.collection.name": "users",
          "aws.dynamodb.table_names": ["users"],
          "aws.dynamodb.index_name": "by-team",
          "db.statement":
            '{"TableName": "users", "IndexName": "by-team", "KeyConditionExpression": "team = :team", ' +
            '"ExpressionAttributeValues": {":team": "?"}}',
          "db.params_hash": expect.stringMatching(/^[0-9a-f]{12}$/),
          "db.params": ["core"],
          "db.response.returned_rows": 2,
          "aws.request_id": "req-1",
          "code.origin": null,
        },
      },
    ]);
  });

  it("tells the same values from others by their hash", async () => {
    const made = await request(async () => {
      for (const id of ["1", "1", "2"]) {
        await client().send(new dynamodb.GetItemCommand({ TableName: "users", Key: { id: { N: id } } }));
      }
    });

    const hashes = calls(made).map((span) => span.attrs["db.params_hash"]);

    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it("counts the SDK's retries, and is an error with AWS's code when it fails", async () => {
    failOnce.add("DynamoDB_20120810.GetItem");
    const made = await request(async () => {
      await client().send(new dynamodb.GetItemCommand({ TableName: "users", Key: { id: { N: "1" } } }));
      await client().send(
        new dynamodb.PutItemCommand({
          TableName: "users",
          Item: { id: { N: "1" } },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
    });

    expect(calls(made).map((span) => [span.name, span.status, span.attrs["aws.retry_attempts"]])).toEqual([
      ["DynamoDB GetItem users", "ok", 1],
      ["DynamoDB PutItem users", "error", undefined],
    ]);
    expect(calls(made)[1]?.attrs).toEqual({
      "rpc.system": "aws-api",
      "rpc.service": "DynamoDB",
      "rpc.method": "PutItem",
      "cloud.region": "eu-west-1",
      "http.response.status_code": 400,
      "error.type": "ConditionalCheckFailedException",
      "db.system": "dynamodb",
      "db.operation": "PutItem",
      "db.collection.name": "users",
      "aws.dynamodb.table_names": ["users"],
      "db.statement": '{"TableName": "users", "Item": {"id": "?"}, "ConditionExpression": "attribute_not_exists(id)"}',
      "db.params_hash": expect.stringMatching(/^[0-9a-f]{12}$/),
      "db.params": ["1"],
      "aws.request_id": "req-1",
      "code.origin": null,
    });
    expect(made.status).toBe("error");
  });
});

describe("SQS, Secrets Manager", () => {
  it("is a message sent to its queue, and any other call an RPC call", async () => {
    const made = await request(async () => {
      await new sqs.SQSClient({ region: "eu-west-1", endpoint, credentials }).send(
        new sqs.SendMessageCommand({ QueueUrl: `${endpoint}/123456789012/orders`, MessageBody: "order 7" }),
      );
      await new secrets.SecretsManagerClient({ region: "eu-west-1", endpoint, credentials }).send(
        new secrets.GetSecretValueCommand({ SecretId: "db" }),
      );
    });

    expect(calls(made)).toEqual([
      {
        ...call,
        kind: "sqs",
        name: "SQS SendMessage orders",
        status: "ok",
        attrs: {
          "rpc.system": "aws-api",
          "rpc.service": "SQS",
          "rpc.method": "SendMessage",
          "cloud.region": "eu-west-1",
          "http.response.status_code": 200,
          "messaging.system": "aws_sqs",
          "messaging.operation": "publish",
          "messaging.destination.name": "orders",
          "messaging.operation.name": "SendMessage",
          "aws.sqs.queue.url": `${endpoint}/123456789012/orders`,
          "messaging.message.id": "msg-1",
          "aws.request_id": "req-1",
          "code.origin": null,
        },
      },
      {
        ...call,
        kind: "rpc",
        name: "Secrets Manager GetSecretValue",
        status: "ok",
        attrs: {
          "rpc.system": "aws-api",
          "rpc.service": "Secrets Manager",
          "rpc.method": "GetSecretValue",
          "cloud.region": "eu-west-1",
          "http.response.status_code": 200,
          "aws.request_id": "req-1",
          "code.origin": null,
        },
      },
    ]);
  });
});

describe("spacedJson", () => {
  it("writes JSON as the Python SDK does", () => {
    expect(spacedJson({ TableName: "users", Keys: [{ id: "?" }], Limit: 5, Live: true, Gone: null })).toBe(
      '{"TableName": "users", "Keys": [{"id": "?"}], "Limit": 5, "Live": true, "Gone": null}',
    );
  });
});
