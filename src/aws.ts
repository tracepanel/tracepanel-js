// AWS: every call the app makes through the AWS SDK's v3 clients (@aws-sdk/client-*), as the Python SDK records
// boto3's: `S3 PutObject bucket/key`.
//
// OpenTelemetry's AWS SDK instrumentation starts a span for each command a client sends, where every client's
// middleware stack resolves it, with the service and operation (`rpc.*`) and the region. Its hooks here add what the
// agent analyzes the call by, from the command's input and output: the call is the operation the app asked for, its
// HTTP requests (retries included) part of it, not calls of their own.
//
// Its kind says what the call does for the app:
// - S3: a `storage` span, `storage.system` s3 with the bucket and key as its path.
// - DynamoDB: a `dynamodb` span, a datastore's command. Its input's shape is `db.statement`, with the item's values
//   as `?`, and the values are `db.params` and `db.params_hash`: the agent tells a loop's GetItem per key (N+1) from
//   the same GetItem again (duplicates) by them. The Document client's commands (@aws-sdk/lib-dynamodb) are the same.
// - SQS's SendMessage and SNS's Publish (their batches too): a message sent, `sqs` and `messaging` spans.
// - Any other call (SQS's ReceiveMessage, Lambda, Secrets Manager…): an `rpc` span, `rpc.system` aws-api.

import { createHash } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import { AwsInstrumentation } from "@opentelemetry/instrumentation-aws-sdk";
import type { Attrs } from "./model.js";

/** The kind of the span a call to AWS is: what it does for the app. */
export const KIND = "tracepanel.aws.kind";
/** What a call works on (`bucket/key`, a table, a queue): the end of its span's name. */
export const TARGET = "tracepanel.aws.target";

const SENDS: Record<string, string[]> = { SQS: ["SendMessage", "SendMessageBatch"], SNS: ["Publish", "PublishBatch"] };
// Where a DynamoDB request carries the app's values (an item, a key, an expression's values): these are `?`.
const VALUES = new Set(["Item", "Key", "Keys", "ExclusiveStartKey", "ExpressionAttributeValues", "Parameters"]);
// A DynamoDB attribute value as the low-level client sends it: {"S": "alice"}.
const TYPES = new Set(["S", "N", "B", "BOOL", "NULL", "SS", "NS", "BS", "L", "M"]);
const MAX_STATEMENT = 2000;
const MAX_PARAMS = 200;

/**
 * AWS's ids of its services, as botocore and the agent write them: the instrumentation takes their spaces out
 * (`SecretsManager`). Any other id has none.
 */
const SPACED = [
  "API Gateway",
  "Bedrock Runtime",
  "CloudWatch Logs",
  "Cognito Identity Provider",
  "DynamoDB Streams",
  "RDS Data",
  "Route 53",
  "SageMaker Runtime",
  "Secrets Manager",
];
const SERVICE_IDS = new Map(SPACED.map((id) => [id.replace(/\s+/g, ""), id]));

/** A service's id as AWS writes it in its SDKs: `S3`, `DynamoDB`, `Secrets Manager`. */
export function serviceId(name: string): string {
  return SERVICE_IDS.get(name) ?? name;
}

type Input = Record<string, unknown>;
type Scalar = string | number | boolean | null;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function scalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  return String(value);
}

// ---------- S3 ----------

function size(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function copySource(source: unknown): string | undefined {
  // The SDK's CopySource is `bucket/key`, URL-encoded.
  const given = text(source);
  if (!given) return undefined;
  try {
    return decodeURIComponent(given);
  } catch {
    return given;
  }
}

function s3(operation: string, input: Input): [string | undefined, Attrs] {
  const bucket = text(input.Bucket);
  const key = text(input.Key);
  // A listing's path is the prefix it lists.
  const inside = key ?? text(input.Prefix);
  const path = bucket && inside ? `${bucket}/${inside}` : bucket;
  return [
    path,
    {
      "storage.backend": "@aws-sdk/client-s3.S3",
      "storage.system": "s3",
      "storage.op": operation,
      "storage.path": path,
      "aws.s3.bucket": bucket,
      "aws.s3.key": key,
      "aws.s3.copy_source": copySource(input.CopySource),
      "aws.s3.upload_id": text(input.UploadId),
      "aws.s3.part_number": int(input.PartNumber),
      "storage.bytes": size(input.Body) ?? int(input.ContentLength),
    },
  ];
}

// ---------- DynamoDB ----------

/** The tables a request works on: its TableName, a batch's RequestItems, a transaction's items. */
function tables(input: Input): string[] {
  const table = text(input.TableName);
  if (table) return [table];
  if (isObject(input.RequestItems)) return Object.keys(input.RequestItems);
  const found: string[] = [];
  for (const item of Array.isArray(input.TransactItems) ? input.TransactItems : []) {
    for (const action of isObject(item) ? Object.values(item) : []) {
      const name = isObject(action) ? text(action.TableName) : undefined;
      if (name && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

/** An item's or a key's values as `?` (collected in order), its attribute names kept. */
function hide(value: unknown, values: Scalar[]): unknown {
  if (isObject(value) && !(value instanceof Set)) {
    const names = Object.keys(value);
    if (names.length === 1 && TYPES.has(names[0] as string)) {
      values.push(scalar(value[names[0] as string]));
      return "?";
    }
    return Object.fromEntries(names.map((name) => [name, hide(value[name], values)]));
  }
  const items = value instanceof Set ? [...value] : value;
  if (Array.isArray(items)) {
    if (items.every((item) => !isObject(item) && !Array.isArray(item))) {
      values.push(...items.map(scalar));
      return ["?"];
    }
    return items.map((item) => hide(item, values));
  }
  values.push(scalar(value));
  return "?";
}

function shape(value: unknown, values: Scalar[]): unknown {
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([name, item]) => [name, VALUES.has(name) ? hide(item, values) : shape(item, values)]),
    );
  }
  if (Array.isArray(value)) return value.map((item) => shape(item, values));
  return value;
}

/** JSON as the Python SDK writes a request's shape: `{"TableName": "users", "Key": {"id": "?"}}`. */
export function spacedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spacedJson).join(", ")}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .map(([name, item]) => `${JSON.stringify(name)}: ${spacedJson(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value === undefined ? null : scalar(value)) ?? "null";
}

function dynamodb(operation: string, input: Input): [string | undefined, Attrs] {
  const names = tables(input);
  const values: Scalar[] = [];
  const statement = spacedJson(shape(input, values));
  return [
    names.join(", ") || undefined,
    {
      "db.system": "dynamodb",
      "db.operation": operation,
      "db.collection.name": names.length === 1 ? names[0] : undefined,
      "aws.dynamodb.table_names": names.length ? names : undefined,
      "aws.dynamodb.index_name": text(input.IndexName),
      "db.statement": statement.length <= MAX_STATEMENT ? statement : `${statement.slice(0, MAX_STATEMENT - 1)}…`,
      "db.params_hash": createHash("sha1").update(JSON.stringify(values)).digest("hex").slice(0, 12),
      "db.params": values.length && values.length <= MAX_PARAMS ? values : undefined,
    },
  ];
}

// ---------- SQS, SNS ----------

/** A queue's name: the last part of its URL. */
function queue(url: unknown): string | undefined {
  return text(url)?.replace(/\/+$/, "").split("/").at(-1) || undefined;
}

function message(service: string, operation: string, input: Input): [string | undefined, Attrs] {
  const entries = input.Entries ?? input.PublishBatchRequestEntries;
  const attrs: Attrs = {
    "messaging.system": service === "SQS" ? "aws_sqs" : "aws.sns",
    "messaging.operation": "publish",
  };
  let destination: string | undefined;
  if (service === "SQS") {
    destination = queue(input.QueueUrl);
    attrs["aws.sqs.queue.url"] = text(input.QueueUrl);
  } else {
    const arn = text(input.TopicArn) ?? text(input.TargetArn);
    destination = arn ? arn.split(":").at(-1) : input.PhoneNumber ? "phone_number" : undefined;
    attrs["aws.sns.topic.arn"] = text(input.TopicArn);
  }
  attrs["messaging.destination.name"] = destination;
  attrs["messaging.operation.name"] = operation;
  attrs["messaging.batch.message_count"] = Array.isArray(entries) ? entries.length : undefined;
  return [destination, attrs];
}

// ---------- every call ----------

function defined(attrs: Attrs): Record<string, NonNullable<unknown>> {
  return Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => value !== undefined && value !== null),
  ) as Record<string, NonNullable<unknown>>;
}

/** The span's kind and what the call works on, from the command the app sent. */
export function described(service: string, operation: string, input: Input): Attrs {
  let kind = "rpc";
  let found: [string | undefined, Attrs] = [undefined, {}];
  if (service === "S3") {
    kind = "storage";
    found = s3(operation, input);
  } else if (service === "DynamoDB") {
    kind = "dynamodb";
    found = dynamodb(operation, input);
  } else if (SENDS[service]?.includes(operation)) {
    kind = service === "SQS" ? "sqs" : "messaging";
    found = message(service, operation, input);
  }
  const [target, attrs] = found;
  return defined({ [KIND]: kind, [TARGET]: target, ...attrs });
}

interface Metadata {
  attempts?: number;
  requestId?: string;
}

/** How many times the SDK retried the call before its answer. */
function retries(metadata: Metadata | undefined): Attrs {
  const attempts = int(metadata?.attempts);
  return attempts !== undefined && attempts > 1 ? { "aws.retry_attempts": attempts - 1 } : {};
}

/** What the operation returned: an object's size, the items a query got, the message's id. */
export function answered(service: string, data: Record<string, unknown> | undefined): Attrs {
  if (!data) return {};
  const attrs: Attrs = retries(data.$metadata as Metadata | undefined);
  if (service === "S3" && int(data.ContentLength) !== undefined) attrs["storage.bytes"] = data.ContentLength;
  if (service === "DynamoDB") {
    const count = int(data.Count) ?? ("Item" in data && data.Item !== undefined ? 1 : undefined);
    if (count !== undefined) attrs["db.response.returned_rows"] = count;
  }
  if (service === "SQS" || service === "SNS") {
    const id = text(data.MessageId);
    if (id) attrs["messaging.message.id"] = id;
  }
  return attrs;
}

/** A failed call's error code (`NoSuchKey`, `ConditionalCheckFailedException`), and the SDK's retries. */
export function failed(error: unknown): Attrs {
  const given = (error ?? {}) as { name?: unknown; Code?: unknown; $metadata?: Metadata };
  const code = text(given.Code) ?? text(given.name) ?? (error as object | undefined)?.constructor?.name ?? "Error";
  // AWS's id of the request, which the instrumentation reads from a successful answer only.
  const id = text(given.$metadata?.requestId);
  return { "error.type": code, ...retries(given.$metadata), ...(id ? { "aws.request.id": id } : {}) };
}

interface Request {
  serviceName: string;
  commandName: string;
  commandInput?: Input;
}

function set(span: Span, attrs: Attrs): void {
  span.setAttributes(defined(attrs) as Parameters<Span["setAttributes"]>[0]);
}

/** OpenTelemetry's AWS SDK instrumentation, its spans carrying what the agent analyzes a call by. */
export function awsInstrumentation(): AwsInstrumentation {
  return new AwsInstrumentation({
    // A call's HTTP requests (one per attempt) are the call, not outgoing calls of their own.
    suppressInternalInstrumentation: true,
    preRequestHook: (span, { request }) => {
      const { serviceName, commandName, commandInput } = request as Request;
      set(span, described(serviceId(serviceName), commandName, commandInput ?? {}));
    },
    responseHook: (span, { response }) => {
      const { data, request } = response as { data?: Record<string, unknown>; request: Request };
      set(span, answered(serviceId(request.serviceName), data));
    },
    exceptionHook: (span, _request, error) => set(span, failed(error)),
  });
}

// The attributes of a call to AWS, as the Python SDK records them: the ones every call has, and its kind's.
const EVERY = [
  "rpc.system",
  "rpc.service",
  "rpc.method",
  "cloud.region",
  "server.address",
  "server.port",
  "http.response.status_code",
  "aws.retry_attempts",
  "error.type",
];
const OF_KIND: Record<string, string[]> = {
  storage: [
    "storage.backend",
    "storage.system",
    "storage.op",
    "storage.path",
    "aws.s3.bucket",
    "aws.s3.key",
    "aws.s3.copy_source",
    "aws.s3.upload_id",
    "aws.s3.part_number",
    "storage.bytes",
  ],
  dynamodb: [
    "db.system",
    "db.operation",
    "db.collection.name",
    "aws.dynamodb.table_names",
    "aws.dynamodb.index_name",
    "db.statement",
    "db.params_hash",
    "db.params",
    "db.response.returned_rows",
  ],
  sqs: [
    "messaging.system",
    "messaging.operation",
    "messaging.destination.name",
    "messaging.operation.name",
    "messaging.batch.message_count",
    "aws.sqs.queue.url",
    "messaging.message.id",
  ],
  messaging: [
    "messaging.system",
    "messaging.operation",
    "messaging.destination.name",
    "messaging.operation.name",
    "messaging.batch.message_count",
    "aws.sns.topic.arn",
    "messaging.message.id",
  ],
};

export function isAws(attrs: Attrs): boolean {
  return attrs["rpc.system"] === "aws-api";
}

/** A call to AWS as the agent reads it: `S3 GetObject avatars/1.png`, its kind and its attributes. */
export function awsCall(attrs: Attrs): { kind: string; name: string; attrs: Attrs } {
  const service = serviceId(String(attrs["rpc.service"] ?? "AWS"));
  const operation = String(attrs["rpc.method"] ?? "");
  const kind = String(attrs[KIND] ?? "rpc");
  const target = attrs[TARGET];
  const own: Attrs = {};
  for (const key of [...EVERY, ...(OF_KIND[kind] ?? [])]) {
    if (attrs[key] !== undefined) own[key] = attrs[key];
  }
  own["rpc.service"] = service;
  // The instrumentation's names of AWS's request ids, as the Python SDK names them.
  if (attrs["aws.request.id"] !== undefined) own["aws.request_id"] = attrs["aws.request.id"];
  if (attrs["aws.request.extended_id"] !== undefined) own["aws.extended_request_id"] = attrs["aws.request.extended_id"];
  return {
    kind,
    name: [service, operation, typeof target === "string" ? target : undefined].filter(Boolean).join(" "),
    attrs: own,
  };
}
