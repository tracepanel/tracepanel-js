// LLM calls: each call the app makes to a model through OpenAI's SDK (`openai`), Anthropic's (`@anthropic-ai/sdk`) or
// any other client of their APIs (the Vercel AI SDK's providers), as a span by OpenTelemetry's GenAI conventions, as
// the Python SDK records them: `chat gpt-5`, `chat claude-sonnet-5-5`, `embeddings text-embedding-3-small`.
//
// The SDKs' clients are wrapped where every API call goes (post(), which retries): a call to an endpoint known here
// is a span under the span current where the app made it, its HTTP calls (one per attempt) its children. Anything
// else that calls these endpoints with fetch() (the AI SDK's OpenAI and Anthropic providers, an OpenAI-compatible
// API's client) gets the same span around its request. Its attributes are the conventions' `gen_ai.*`: the provider,
// the operation, the model asked for and the one that answered, the request's settings (max_tokens, temperature),
// why the model stopped, the tokens it used (cost is the agent's to work out), and the names of the tools it called.
// A failed call (a rate limit, an overloaded API, a timeout) is an error, `error.type` its error's class (an HTTP
// status for a fetch()), with the HTTP status the API answered.
//
// A streamed answer's span lasts until its last event: its first event's time is
// `gen_ai.response.time_to_first_chunk` (seconds, as the conventions have it), and the usage the last events carry
// is counted. The conventions have no attribute for the tools a model called: `gen_ai.response.tool_calls` names
// them, in order, and `gen_ai.response.tool_call_count` counts them. The messages themselves are not recorded.
//
// The spans are of their own kind, `llm` (`tracepanel.span_kind`). Anthropic's SDK makes an OpenTelemetry span of
// its own for each call: the processor leaves those out, so a call shows once.

import {
  type Attributes,
  context,
  createContextKey,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from "@opentelemetry/instrumentation";
import type { Attrs } from "./model.js";

/** The span kind of an LLM call, in `tracepanel.span_kind`. */
export const KIND = "llm";
/** The instrumentation scope of Anthropic's SDK's own spans: the processor leaves them out. */
export const ANTHROPIC_SCOPE = "com.anthropic.sdk";

/** Set in the context of an LLM call's span: the requests made inside it are the call's. */
const IN_CALL = createContextKey("tracepanel.llm_call");
const tracer = trace.getTracer("tracepanel-llm");

type Body = Record<string, unknown>;
type Scalar = string | number | boolean;

function get(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function scalar(value: unknown): Scalar | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

/** `gen_ai.request.<attr>` for each request field in `names` (field → attr) the body has. */
function settings(body: Body, names: Record<string, string>): Attrs {
  const attrs: Attrs = {};
  for (const [name, attr] of Object.entries(names)) {
    const value = body[name];
    if (typeof value === "string" && attr === "stop_sequences") attrs[`gen_ai.request.${attr}`] = [value];
    else if (Array.isArray(value)) attrs[`gen_ai.request.${attr}`] = value.map(String);
    else if (scalar(value) !== undefined) attrs[`gen_ai.request.${attr}`] = value;
  }
  return attrs;
}

/** Tokens, as the conventions count them: the input's total includes what the cache served or stored. */
interface Usage {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  reasoning?: number | undefined;
}

function usageAttrs(usage: Usage): Attrs {
  const attrs: Attrs = {};
  const counts: [number | undefined, string][] = [
    [usage.input, "input_tokens"],
    [usage.output, "output_tokens"],
    [usage.cacheRead, "cache_read.input_tokens"],
    [usage.cacheWrite, "cache_write.input_tokens"],
    [usage.reasoning, "reasoning.output_tokens"],
  ];
  for (const [value, attr] of counts) {
    // The detailed counts only when there are some, as the conventions ask.
    if (int(value) !== undefined && (value || attr === "input_tokens" || attr === "output_tokens")) {
      attrs[`gen_ai.usage.${attr}`] = value;
    }
  }
  return attrs;
}

/** What a call's answer says: from the response, or put together from a stream's events. */
interface Reply {
  id?: string | undefined;
  model?: string | undefined;
  finishReasons: string[];
  usage: Usage;
  tools: string[];
}

function reply(): Reply {
  return { finishReasons: [], usage: {}, tools: [] };
}

function replyAttrs(found: Reply): Attrs {
  const attrs: Attrs = {};
  if (found.id) attrs["gen_ai.response.id"] = found.id;
  if (found.model) attrs["gen_ai.response.model"] = found.model;
  if (found.finishReasons.length) attrs["gen_ai.response.finish_reasons"] = found.finishReasons;
  Object.assign(attrs, usageAttrs(found.usage));
  if (found.tools.length) {
    attrs["gen_ai.response.tool_calls"] = found.tools;
    attrs["gen_ai.response.tool_call_count"] = found.tools.length;
  }
  return attrs;
}

/** A stream's events, read as they come: what the call's answer was, once the stream is over. */
interface Events {
  add(event: unknown): void;
  reply(): Reply;
}

/** One endpoint a provider knows: the operation it is, and how to read its request and its answer. */
interface Endpoint {
  provider: "openai" | "anthropic";
  operation: string;
  /** The request's attributes from its JSON body (the model, its settings). */
  request(body: Body): Attrs;
  /** The answer, from its JSON. */
  reply(answer: unknown): Reply;
  /** What reads a stream's events. */
  events?: () => Events;
  /** Attributes of the provider's own (openai.api.type). */
  extra?: Attrs;
}

function model(body: Body): Attrs {
  return typeof body.model === "string" ? { "gen_ai.request.model": body.model } : {};
}

// ---------- OpenAI ----------

const CHAT_SETTINGS = {
  max_tokens: "max_tokens",
  max_completion_tokens: "max_tokens",
  temperature: "temperature",
  top_p: "top_p",
  frequency_penalty: "frequency_penalty",
  presence_penalty: "presence_penalty",
  seed: "seed",
  stop: "stop_sequences",
  reasoning_effort: "reasoning.level",
};
const RESPONSES_SETTINGS = {
  max_output_tokens: "max_tokens",
  temperature: "temperature",
  top_p: "top_p",
  previous_response_id: "previous_response.id",
};

function openaiUsage(usage: unknown, input: string, output: string): Usage {
  if (usage === null || usage === undefined) return {};
  return {
    input: int(get(usage, input)),
    output: int(get(usage, output)),
    cacheRead: int(get(get(usage, `${input}_details`), "cached_tokens")),
    reasoning: int(get(get(usage, `${output}_details`), "reasoning_tokens")),
  };
}

function chatRequest(body: Body): Attrs {
  const attrs = { ...model(body), ...settings(body, CHAT_SETTINGS) };
  const choices = int(body.n);
  if (choices !== undefined && choices !== 1) attrs["gen_ai.request.choice.count"] = choices;
  return attrs;
}

function chatReply(answer: unknown): Reply {
  const found: Reply = {
    ...reply(),
    id: str(get(answer, "id")),
    model: str(get(answer, "model")),
    usage: openaiUsage(get(answer, "usage"), "prompt_tokens", "completion_tokens"),
  };
  for (const choice of items(get(answer, "choices"))) {
    const reason = get(choice, "finish_reason");
    found.finishReasons.push(reason === null || reason === undefined ? "error" : String(reason));
    for (const call of items(get(get(choice, "message"), "tool_calls"))) {
      found.tools.push(String(get(get(call, "function"), "name")));
    }
  }
  return found;
}

/** A streamed chat completion: each choice's tool calls and finish reason, the usage at the end. */
function chatEvents(): Events {
  const found = reply();
  // Each choice by its index: its tool calls' names by their index, its finish reasons.
  type Choice = { calls: Map<number, string>; reasons: string[] };
  const choices = new Map<number, Choice>();
  return {
    add(event) {
      found.id ??= str(get(event, "id"));
      found.model ??= str(get(event, "model"));
      const usage = get(event, "usage");
      if (usage !== null && usage !== undefined) found.usage = openaiUsage(usage, "prompt_tokens", "completion_tokens");
      for (const choice of items(get(event, "choices"))) {
        const index = int(get(choice, "index")) ?? 0;
        const known: Choice = choices.get(index) ?? { calls: new Map(), reasons: [] };
        choices.set(index, known);
        for (const call of items(get(get(choice, "delta"), "tool_calls"))) {
          const at = int(get(call, "index")) ?? 0;
          const name = str(get(get(call, "function"), "name"));
          if (name || !known.calls.has(at)) known.calls.set(at, name ?? known.calls.get(at) ?? "");
        }
        const reason = get(choice, "finish_reason");
        if (reason !== null && reason !== undefined) known.reasons.push(String(reason));
      }
    },
    reply() {
      for (const index of [...choices.keys()].sort((a, b) => a - b)) {
        const { calls, reasons } = choices.get(index) as Choice;
        found.finishReasons.push(reasons.at(-1) ?? "error");
        found.tools.push(...[...calls.keys()].sort((a, b) => a - b).map((at) => calls.get(at) as string));
      }
      return found;
    },
  };
}

function responsesRequest(body: Body): Attrs {
  const attrs = { ...model(body), ...settings(body, RESPONSES_SETTINGS) };
  const effort = get(body.reasoning, "effort");
  if (typeof effort === "string") attrs["gen_ai.request.reasoning.level"] = effort;
  return attrs;
}

function responseReply(answer: unknown): Reply {
  const reason = str(get(get(answer, "incomplete_details"), "reason")) ?? str(get(answer, "status")) ?? "error";
  const found: Reply = {
    ...reply(),
    id: str(get(answer, "id")),
    model: str(get(answer, "model")),
    finishReasons: [reason],
    usage: openaiUsage(get(answer, "usage"), "input_tokens", "output_tokens"),
  };
  for (const item of items(get(answer, "output"))) {
    const kind = get(item, "type");
    if (kind === "function_call" || kind === "custom_tool_call") found.tools.push(String(get(item, "name")));
  }
  return found;
}

/** A streamed response: its events end with the whole response (completed, incomplete or failed). */
function responseEvents(): Events {
  let response: unknown;
  return {
    add(event) {
      const found = get(event, "response");
      if (found !== undefined && found !== null) response = found;
    },
    reply: () => (response === undefined ? { ...reply(), finishReasons: ["error"] } : responseReply(response)),
  };
}

function embeddingsRequest(body: Body): Attrs {
  const attrs = model(body);
  if (typeof body.encoding_format === "string") attrs["gen_ai.request.encoding_formats"] = [body.encoding_format];
  const dimensions = int(body.dimensions);
  if (dimensions !== undefined) attrs["gen_ai.embeddings.dimension.count"] = dimensions;
  return attrs;
}

function embeddingsReply(answer: unknown): Reply {
  return {
    ...reply(),
    model: str(get(answer, "model")),
    usage: { input: int(get(get(answer, "usage"), "prompt_tokens")) },
  };
}

// ---------- Anthropic ----------

const ANTHROPIC_SETTINGS = {
  max_tokens: "max_tokens",
  temperature: "temperature",
  top_p: "top_p",
  top_k: "top_k",
  stop_sequences: "stop_sequences",
};
const TOOL_USES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

function messagesRequest(body: Body): Attrs {
  const attrs = { ...model(body), ...settings(body, ANTHROPIC_SETTINGS) };
  const effort = get(body.output_config, "effort");
  if (typeof effort === "string") attrs["gen_ai.request.reasoning.level"] = effort;
  return attrs;
}

/** The usage a message or its stream's last event reports, over what an earlier event did. */
function anthropicUsage(usage: unknown, into: Usage = {}): Usage {
  if (usage === null || usage === undefined) return into;
  const read = int(get(usage, "cache_read_input_tokens"));
  const written = int(get(usage, "cache_creation_input_tokens"));
  const found = { ...into };
  if (read !== undefined) found.cacheRead = read;
  if (written !== undefined) found.cacheWrite = written;
  const input = int(get(usage, "input_tokens"));
  if (input !== undefined) found.input = input + (found.cacheRead ?? 0) + (found.cacheWrite ?? 0);
  const output = int(get(usage, "output_tokens"));
  if (output !== undefined) found.output = output;
  return found;
}

function messageReply(answer: unknown): Reply {
  const reason = get(answer, "stop_reason");
  return {
    id: str(get(answer, "id")),
    model: str(get(answer, "model")),
    finishReasons: [reason === null || reason === undefined ? "error" : String(reason)],
    usage: anthropicUsage(get(answer, "usage")),
    tools: items(get(answer, "content"))
      .filter((block) => TOOL_USES.has(String(get(block, "type"))))
      .map((block) => String(get(block, "name"))),
  };
}

/** A streamed message: message_start's id, model and input usage, the tools its blocks call, message_delta's end. */
function messageEvents(): Events {
  const found = reply();
  let reason: string | undefined;
  return {
    add(event) {
      const kind = get(event, "type");
      if (kind === "message_start") {
        const message = get(event, "message");
        found.id = str(get(message, "id"));
        found.model = str(get(message, "model"));
        found.usage = anthropicUsage(get(message, "usage"), found.usage);
      } else if (kind === "content_block_start") {
        const block = get(event, "content_block");
        if (TOOL_USES.has(String(get(block, "type")))) found.tools.push(String(get(block, "name")));
      } else if (kind === "message_delta") {
        reason = str(get(get(event, "delta"), "stop_reason")) ?? reason;
        found.usage = anthropicUsage(get(event, "usage"), found.usage);
      }
    },
    reply: () => ({ ...found, finishReasons: [reason ?? "error"] }),
  };
}

// ---------- the endpoints ----------

/** The endpoints, by the end of their path: an SDK's client calls them by it, fetch() by the whole URL. */
const ENDPOINTS: Record<string, Endpoint> = {
  "/chat/completions": {
    provider: "openai",
    operation: "chat",
    request: chatRequest,
    reply: chatReply,
    events: chatEvents,
    extra: { "openai.api.type": "chat_completions" },
  },
  "/responses": {
    provider: "openai",
    operation: "chat",
    request: responsesRequest,
    reply: responseReply,
    events: responseEvents,
    extra: { "openai.api.type": "responses" },
  },
  "/embeddings": { provider: "openai", operation: "embeddings", request: embeddingsRequest, reply: embeddingsReply },
  "/v1/messages": {
    provider: "anthropic",
    operation: "chat",
    request: messagesRequest,
    reply: messageReply,
    events: messageEvents,
  },
};

function endpoint(path: string): Endpoint | undefined {
  const clean = path.split("?")[0]?.replace(/\/+$/, "") ?? "";
  for (const [end, found] of Object.entries(ENDPOINTS)) {
    if (clean === end || clean.endsWith(end)) return found;
  }
  return undefined;
}

/** The provider an API's host is, by the conventions' names; an unknown host's is the API's own. */
const HOSTS: [RegExp, string][] = [
  [/(^|\.)openai\.azure\.com$/, "azure.ai.openai"],
  [/(^|\.)api\.groq\.com$/, "groq"],
  [/(^|\.)api\.deepseek\.com$/, "deepseek"],
  [/(^|\.)api\.mistral\.ai$/, "mistral_ai"],
  [/(^|\.)api\.x\.ai$/, "x_ai"],
  [/(^|\.)api\.perplexity\.ai$/, "perplexity"],
];

function server(url: string | URL | undefined): Attrs {
  try {
    const { hostname, port, protocol } = new URL(String(url));
    if (!hostname) return {};
    return { "server.address": hostname, "server.port": port ? Number(port) : protocol === "https:" ? 443 : 80 };
  } catch {
    return {};
  }
}

// ---------- a call ----------

/** One API call's span: open while the call is made, then until its stream's last event. */
class Call {
  private events: Events | undefined;
  private first = false;
  private done = false;
  private readonly started = performance.now();

  private stream = false;

  constructor(
    readonly span: Span,
    private readonly found: Endpoint,
  ) {}

  /** What the app asked for: the model, its settings, a stream. */
  describe(body: Body, stream: boolean): void {
    const request = this.found.request(body);
    const asked = request["gen_ai.request.model"];
    this.stream = stream;
    this.span.setAttributes({ ...request, ...(stream ? { "gen_ai.request.stream": true } : {}) } as Attributes);
    if (typeof asked === "string") this.span.updateName(`${this.found.operation} ${asked}`);
  }

  /** The call failed: its span is an error, ended now. */
  failed(type: string, status?: number): void {
    if (this.done) return;
    this.done = true;
    this.span.setStatus({ code: SpanStatusCode.ERROR });
    this.span.setAttribute("error.type", type);
    if (status !== undefined) this.span.setAttribute("http.response.status_code", status);
    this.span.end();
  }

  /** The call's error, as the SDK threw it: its class, and the HTTP status the API answered. */
  thrown(error: unknown): void {
    const status = int(get(error, "status"));
    this.failed((error as object | undefined)?.constructor?.name || "Error", status);
  }

  /** The answer: read now, or its stream followed to its end. A copy of it: the app reads the response itself. */
  answered(response: Response): void {
    if (this.done) return;
    let copy: Response;
    try {
      copy = response.clone();
    } catch {
      this.finish();
      return;
    }
    const streamed = this.stream || (copy.headers.get("content-type") ?? "").includes("text/event-stream");
    if (streamed && this.found.events && copy.body) {
      this.events = this.found.events();
      this.follow(copy.body).catch(() => this.finish());
      return;
    }
    copy
      .json()
      .then((answer) => this.finish(replyAttrs(this.found.reply(answer))))
      .catch(() => this.finish());
  }

  private async follow(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(piece, { stream: true });
        const blocks = buffered.split(/\r?\n\r?\n/);
        buffered = blocks.pop() ?? "";
        for (const block of blocks) this.event(block);
      }
      this.event(buffered);
    } catch {
      // The app closed the stream (or the connection broke): what came until then is the answer.
    }
    this.finish(this.events ? replyAttrs(this.events.reply()) : {});
  }

  /** One server-sent event: its data lines, JSON. */
  private event(block: string): void {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    if (!this.first) {
      this.first = true;
      const seconds = (performance.now() - this.started) / 1000;
      this.span.setAttribute("gen_ai.response.time_to_first_chunk", Math.round(seconds * 1e6) / 1e6);
    }
    try {
      this.events?.add(JSON.parse(data));
    } catch {
      // Not JSON: not an event of the API's.
    }
  }

  private finish(attrs: Attrs = {}): void {
    if (this.done) return;
    this.done = true;
    this.span.setAttributes(attrs as Attributes);
    this.span.end();
  }
}

/** The call's span, open, when the app makes a call to a known endpoint inside a trace. */
function begin(found: Endpoint, provider: string, url: string | URL | undefined): Call {
  const attributes = {
    "tracepanel.span_kind": KIND,
    "gen_ai.provider.name": provider,
    "gen_ai.operation.name": found.operation,
    ...found.extra,
    ...server(url),
  };
  const span = tracer.startSpan(found.operation, { kind: SpanKind.CLIENT, attributes: attributes as Attributes });
  return new Call(span, found);
}

/** The context an LLM call's requests are made in: its span's. */
function inside(call: Call) {
  return trace.setSpan(context.active(), call.span).setValue(IN_CALL, true);
}

/** Whether the current span is an LLM call already: ours, or another instrumentation's model call. */
function inCall(): boolean {
  if (context.active().getValue(IN_CALL)) return true;
  const operation = (trace.getActiveSpan() as { attributes?: Attributes } | undefined)?.attributes?.[
    "gen_ai.operation.name"
  ];
  return operation === "chat" || operation === "text_completion" || operation === "embeddings";
}

// ---------- the SDKs ----------

interface ApiPromise {
  responsePromise?: Promise<{ response: Response }>;
}

interface Client {
  baseURL?: string;
  constructor: { name: string };
}

type Post = (this: Client, path: string, opts?: unknown) => ApiPromise;

/** gen_ai.provider.name for a client, by its class. */
function clientProvider(client: Client, found: Endpoint): string {
  const name = client.constructor?.name ?? "";
  if (found.provider === "openai") return name.includes("Azure") ? "azure.ai.openai" : "openai";
  if (name.includes("Bedrock")) return "aws.bedrock";
  if (name.includes("Vertex")) return "gcp.vertex_ai";
  return "anthropic";
}

/** The client's post(): a call to a known endpoint, with its retries, as one span. */
function tracedPost(original: Post): Post {
  return function (this: Client, path: string, opts?: unknown) {
    const found = typeof path === "string" && trace.getActiveSpan() && !inCall() ? endpoint(path) : undefined;
    if (!found) return original.call(this, path, opts);
    const call = begin(found, clientProvider(this, found), this.baseURL);
    // The request's options, or (OpenAI's) a promise of them, which the SDK awaits before it sends the request.
    const described = (given: unknown) => {
      const body = get(given, "body");
      call.describe(body !== null && typeof body === "object" ? (body as Body) : {}, get(given, "stream") === true);
    };
    if (typeof (opts as PromiseLike<unknown> | undefined)?.then === "function") {
      (opts as PromiseLike<unknown>).then(described, () => {});
    } else described(opts);
    let promise: ApiPromise;
    try {
      promise = context.with(inside(call), () => original.call(this, path, opts));
    } catch (error) {
      call.thrown(error);
      throw error;
    }
    const answer = promise?.responsePromise;
    if (!answer || typeof answer.then !== "function") {
      call.failed("Error");
      return promise;
    }
    // The SDK's promise parses the response when the app awaits it: the call's span reads a copy as it arrives.
    const followed = answer.then(
      (props) => {
        call.answered(props.response);
        return props;
      },
      (error: unknown) => {
        call.thrown(error);
        throw error;
      },
    );
    // Its failure is the app's to handle where it awaits the call, as the SDK's own promise's is.
    followed.catch(() => {});
    promise.responsePromise = followed;
    return promise;
  };
}

type Exports = Record<string, { prototype?: { post?: Post } } | undefined>;

/** OpenAI's and Anthropic's clients, their API calls as LLM call spans. */
export class LlmInstrumentation extends InstrumentationBase {
  constructor() {
    super("tracepanel-llm", "1.0.0", {});
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition("openai", [">=4 <8"], (exports: Exports) =>
        this.patch(exports, ["OpenAI", "default"]),
      ),
      new InstrumentationNodeModuleDefinition("@anthropic-ai/sdk", [">=0.20 <2"], (exports: Exports) =>
        this.patch(exports, ["Anthropic", "default"]),
      ),
    ];
  }

  private patch(exports: Exports, names: string[]): Exports {
    for (const name of names) {
      const prototype = exports[name]?.prototype as { post: Post } | undefined;
      if (typeof prototype?.post === "function" && !isWrapped(prototype.post)) {
        this._wrap(prototype, "post", (original) => tracedPost(original));
      }
    }
    return exports;
  }
}

// ---------- fetch() ----------

function urlOf(input: unknown): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return undefined;
  }
}

function fetchProvider(url: URL, found: Endpoint): string {
  return HOSTS.find(([host]) => host.test(url.hostname))?.[1] ?? found.provider;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const WRAPPED = Symbol.for("tracepanel.llm.fetch");

/**
 * fetch(), its calls to a model's API (a POST of JSON with a model to a known endpoint) as LLM call spans: what the
 * AI SDK's providers and other clients of these APIs send. One an SDK's client makes is that call's already.
 */
export function llmFetch<F extends Fetch>(fetch: F): F {
  if ((fetch as { [WRAPPED]?: boolean })[WRAPPED]) return fetch;
  const wrapped = function (this: unknown, input: string | URL | Request, init?: RequestInit) {
    const plain = () => fetch.call(this, input, init);
    if (!trace.getActiveSpan() || inCall() || typeof init?.body !== "string") return plain();
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = urlOf(input);
    const found = method === "POST" && url ? endpoint(url.pathname) : undefined;
    if (!url || !found) return plain();
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return plain();
    }
    if (typeof get(body, "model") !== "string") return plain();
    const call = begin(found, fetchProvider(url, found), url);
    call.describe(body as Body, get(body, "stream") === true);
    return context.with(inside(call), plain).then(
      (response) => {
        if (response.ok) call.answered(response);
        else call.failed(String(response.status), response.status);
        return response;
      },
      (error: unknown) => {
        call.thrown(error);
        throw error;
      },
    );
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return Object.assign(wrapped, fetch) as unknown as F;
}

/** globalThis.fetch, its LLM calls traced, once per process. */
export function traceLlmFetch(): void {
  if (typeof globalThis.fetch !== "function") return;
  globalThis.fetch = llmFetch(globalThis.fetch);
}
