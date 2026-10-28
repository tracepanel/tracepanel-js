// LLM calls through OpenAI's and Anthropic's SDKs and the AI SDK, against a local stand-in for their APIs: each call
// to a model is one `llm` span with the GenAI conventions' attributes, as the Python SDK records them.
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { LlmInstrumentation, llmFetch } from "../src/llm.js";
import type { Span, Trace } from "../src/model.js";
import { TracepanelProcessor } from "../src/processor.js";

const config: Config = { ...loadConfig({}), enabled: true, root: "/app", service: "shop" };
const sent: Trace[] = [];
const processor = new TracepanelProcessor(config, { submit: (made) => sent.push(made) });
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const manager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(manager);
// Anthropic's SDK makes spans of its own through the global provider: the processor leaves them out.
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer("test");

// The instrumentation hooks the SDKs as they load: before they are required.
const instrumentation = new LlmInstrumentation();
instrumentation.setTracerProvider(provider);
instrumentation.enable();
const require = createRequire(import.meta.url);
const { default: OpenAI } = require("openai") as typeof import("openai");
const { default: Anthropic } = require("@anthropic-ai/sdk") as typeof import("@anthropic-ai/sdk");
// The AI SDK's providers call the API with the global fetch.
globalThis.fetch = llmFetch(globalThis.fetch);
const { generateText } = await import("ai");
const { createOpenAI } = await import("@ai-sdk/openai");
const { createAnthropic } = await import("@ai-sdk/anthropic");

const usage = {
  prompt_tokens: 12,
  completion_tokens: 5,
  total_tokens: 17,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens_details: { reasoning_tokens: 0 },
};
const completion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-5-2025-08-07",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Oslo"}' } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage,
};
const chunk = (delta: unknown, finish: string | null) => ({
  id: "chatcmpl-2",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-5-2025-08-07",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const response = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-5-2025-08-07",
  output: [
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};
const message = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5-20260901",
  content: [{ type: "text", text: "Hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function events(res: ServerResponse, sent: [string | null, unknown][]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [name, data] of sent) {
    res.write(`${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  }
  res.end();
}

/** Calls to answer with a rate limit once, by model: the SDK retries them. */
const limitedOnce = new Set<string>();

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const piece of req) raw += piece;
  const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean };
  if (body.model && limitedOnce.delete(body.model)) {
    json(res, 429, { error: { message: "slow down", type: "rate_limit_error" } }, { "retry-after-ms": "1" });
  } else if (body.model === "missing") {
    json(res, 404, { error: { message: "no such model", type: "invalid_request_error" } });
  } else if (req.url === "/v1/chat/completions" && body.stream) {
    events(res, [
      [null, chunk({ role: "assistant", content: "Hi" }, null)],
      [null, chunk({}, "stop")],
      [null, { ...chunk({}, null), choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }],
      [null, "[DONE]"],
    ]);
  } else if (req.url === "/v1/chat/completions") {
    json(res, 200, completion);
  } else if (req.url === "/v1/responses") {
    json(res, 200, response);
  } else if (req.url === "/v1/embeddings") {
    const embedding = Buffer.from(new Float32Array([0.1, 0.2]).buffer).toString("base64");
    json(res, 200, {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
  } else if (req.url?.startsWith("/v1/messages") && body.stream) {
    const start = { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
    events(res, [
      ["message_start", { type: "message_start", message: start }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "weather", input: {} },
        },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Oslo"}' } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } },
      ],
      ["message_stop", { type: "message_stop" }],
    ]);
  } else if (req.url?.startsWith("/v1/messages")) {
    json(res, 200, message);
  } else {
    json(res, 404, { error: { message: "not here" } });
  }
});

let endpoint = "";
let port = 0;

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
  endpoint = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  manager.disable();
});

beforeEach(() => {
  sent.length = 0;
});

/** The request's trace, with the calls `app` made inside it. */
async function request(app: () => Promise<unknown>): Promise<Trace> {
  const root = tracer.startSpan("POST", {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "POST", "url.path": "/ask" },
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
  kind: "llm",
  start: expect.any(Number),
  duration: expect.any(Number),
};

describe("OpenAI", () => {
  const client = () => new OpenAI({ apiKey: "sk-test", baseURL: `${endpoint}/v1`, maxRetries: 2 });

  it("is a chat call each: the model asked for and the one that answered, the tokens, the tools it called", async () => {
    const made = await request(() =>
      client().chat.completions.create({
        model: "gpt-5",
        messages: [{ role: "user", content: "Weather in Oslo?" }],
        max_completion_tokens: 100,
        temperature: 0.2,
        stop: "END",
      }),
    );

    expect(calls(made)).toEqual([
      {
        ...call,
        name: "chat gpt-5",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "openai.api.type": "chat_completions",
          "gen_ai.request.model": "gpt-5",
          "gen_ai.request.max_tokens": 100,
          "gen_ai.request.temperature": 0.2,
          "gen_ai.request.stop_sequences": ["END"],
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.id": "chatcmpl-1",
          "gen_ai.response.model": "gpt-5-2025-08-07",
          "gen_ai.response.finish_reasons": ["tool_calls"],
          "gen_ai.usage.input_tokens": 12,
          "gen_ai.usage.output_tokens": 5,
          "gen_ai.usage.cache_read.input_tokens": 4,
          "gen_ai.response.tool_calls": ["weather"],
          "gen_ai.response.tool_call_count": 1,
          "code.origin": null,
        },
      },
    ]);
  });

  it("follows a stream to its end: its first chunk's time, the usage its last chunk carries", async () => {
    const made = await request(async () => {
      const stream = await client().chat.completions.create({
        model: "gpt-5",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const _ of stream) {
        // The app reads the answer.
      }
    });

    expect(calls(made)).toEqual([
      {
        ...call,
        name: "chat gpt-5",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "openai.api.type": "chat_completions",
          "gen_ai.request.model": "gpt-5",
          "gen_ai.request.stream": true,
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.time_to_first_chunk": expect.any(Number),
          "gen_ai.response.id": "chatcmpl-2",
          "gen_ai.response.model": "gpt-5-2025-08-07",
          "gen_ai.response.finish_reasons": ["stop"],
          "gen_ai.usage.input_tokens": 12,
          "gen_ai.usage.output_tokens": 2,
          "code.origin": null,
        },
      },
    ]);
  });

  it("is a response, and embeddings, each a call", async () => {
    const made = await request(async () => {
      await client().responses.create({ model: "gpt-5", input: "Hi", reasoning: { effort: "low" } });
      await client().embeddings.create({ model: "text-embedding-3-small", input: "Hi", dimensions: 2 });
    });

    expect(calls(made)).toEqual([
      {
        ...call,
        name: "chat gpt-5",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "openai.api.type": "responses",
          "gen_ai.request.model": "gpt-5",
          "gen_ai.request.reasoning.level": "low",
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.id": "resp_1",
          "gen_ai.response.model": "gpt-5-2025-08-07",
          "gen_ai.response.finish_reasons": ["completed"],
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 3,
          "code.origin": null,
        },
      },
      {
        ...call,
        name: "embeddings text-embedding-3-small",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "embeddings",
          "gen_ai.request.model": "text-embedding-3-small",
          "gen_ai.request.encoding_formats": ["base64"],
          "gen_ai.embeddings.dimension.count": 2,
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.model": "text-embedding-3-small",
          "gen_ai.usage.input_tokens": 3,
          "code.origin": null,
        },
      },
    ]);
  });

  it("is one call with its retries, and an error with the SDK's error and the API's status when it fails", async () => {
    limitedOnce.add("gpt-5-mini");
    const made = await request(async () => {
      await client().chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content: "Hi" }] });
      await client().chat.completions.create({ model: "missing", messages: [{ role: "user", content: "Hi" }] });
    });

    expect(calls(made).filter((span) => span.kind === "llm")).toEqual([
      {
        ...call,
        name: "chat gpt-5-mini",
        status: "ok",
        attrs: expect.objectContaining({ "gen_ai.request.model": "gpt-5-mini", "gen_ai.response.id": "chatcmpl-1" }),
      },
      {
        ...call,
        name: "chat missing",
        status: "error",
        attrs: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "openai.api.type": "chat_completions",
          "gen_ai.request.model": "missing",
          "server.address": "127.0.0.1",
          "server.port": port,
          "error.type": "NotFoundError",
          "http.response.status_code": 404,
          "code.origin": null,
        },
      },
    ]);
  });
});

describe("Anthropic", () => {
  const client = () => new Anthropic({ apiKey: "sk-ant-test", baseURL: endpoint });

  it("is a chat call: the input's tokens with what the cache served and stored, and once, not the SDK's span too", async () => {
    const made = await request(() =>
      client().messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    expect(calls(made)).toEqual([
      {
        ...call,
        name: "chat claude-sonnet-5-5",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "anthropic",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "claude-sonnet-5-5",
          "gen_ai.request.max_tokens": 1024,
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.id": "msg_01",
          "gen_ai.response.model": "claude-sonnet-5-5-20260901",
          "gen_ai.response.finish_reasons": ["end_turn"],
          "gen_ai.usage.input_tokens": 130,
          "gen_ai.usage.output_tokens": 3,
          "gen_ai.usage.cache_read.input_tokens": 100,
          "gen_ai.usage.cache_write.input_tokens": 20,
          "code.origin": null,
        },
      },
    ]);
  });

  it("follows a stream: the tool its blocks call, message_delta's end and usage", async () => {
    const made = await request(async () => {
      const stream = await client().messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Weather in Oslo?" }],
        stream: true,
      });
      for await (const _ of stream) {
        // The app reads the answer.
      }
    });

    expect(calls(made)).toEqual([
      {
        ...call,
        name: "chat claude-sonnet-5-5",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "anthropic",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "claude-sonnet-5-5",
          "gen_ai.request.max_tokens": 1024,
          "gen_ai.request.stream": true,
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.time_to_first_chunk": expect.any(Number),
          "gen_ai.response.id": "msg_01",
          "gen_ai.response.model": "claude-sonnet-5-5-20260901",
          "gen_ai.response.finish_reasons": ["tool_use"],
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 7,
          "gen_ai.response.tool_calls": ["weather"],
          "gen_ai.response.tool_call_count": 1,
          "code.origin": null,
        },
      },
    ]);
  });
});

describe("the AI SDK", () => {
  it("is a call through its Anthropic provider's fetch()", async () => {
    const anthropic = createAnthropic({ apiKey: "sk-ant-test", baseURL: `${endpoint}/v1` });

    const made = await request(() =>
      generateText({ model: anthropic("claude-sonnet-5-5"), prompt: "Hi", maxOutputTokens: 256 }),
    );

    expect(calls(made).filter((span) => span.kind === "llm")).toEqual([
      {
        ...call,
        name: "chat claude-sonnet-5-5",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "anthropic",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "claude-sonnet-5-5",
          "gen_ai.request.max_tokens": 256,
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.id": "msg_01",
          "gen_ai.response.model": "claude-sonnet-5-5-20260901",
          "gen_ai.response.finish_reasons": ["end_turn"],
          "gen_ai.usage.input_tokens": 130,
          "gen_ai.usage.output_tokens": 3,
          "gen_ai.usage.cache_read.input_tokens": 100,
          "gen_ai.usage.cache_write.input_tokens": 20,
          "code.origin": null,
        },
      },
    ]);
  });

  it("is a call through its OpenAI provider's fetch()", async () => {
    const openai = createOpenAI({ apiKey: "sk-test", baseURL: `${endpoint}/v1` });

    const made = await request(() => generateText({ model: openai("gpt-4.1"), prompt: "Hi", temperature: 0.5 }));

    expect(calls(made).filter((span) => span.kind === "llm")).toEqual([
      {
        ...call,
        name: "chat gpt-4.1",
        status: "ok",
        attrs: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "openai.api.type": "responses",
          "gen_ai.request.model": "gpt-4.1",
          "gen_ai.request.temperature": 0.5,
          "server.address": "127.0.0.1",
          "server.port": port,
          "gen_ai.response.id": "resp_1",
          "gen_ai.response.model": "gpt-5-2025-08-07",
          "gen_ai.response.finish_reasons": ["completed"],
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 3,
          "code.origin": null,
        },
      },
    ]);
  });
});
