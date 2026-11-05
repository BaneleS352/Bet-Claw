import { z } from "zod";

import { createPolicyFetch, loadConfig } from "@openclaw/config";
import { redactSensitiveText, type AppConfig } from "@openclaw/shared";

export const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.string().min(1)
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional()
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type ChatDelta = {
  content?: string;
  role?: ChatRole;
  done?: boolean;
};

export const embeddingRequestSchema = z.object({
  input: z.array(z.string()).min(1)
});

export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;

export interface ChatProvider {
  streamChat(req: ChatRequest): AsyncIterable<ChatDelta>;
}

export interface EmbeddingProvider {
  embed(input: string[]): Promise<number[][]>;
}

export type LlmProvider = ChatProvider & EmbeddingProvider;

export type OpenAICompatibleProviderOptions = {
  config?: AppConfig;
  fetchImpl?: typeof fetch;
};

const chatChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            role: z.enum(["system", "user", "assistant", "tool"]).optional(),
            content: z.string().optional()
          })
          .default({}),
        finish_reason: z.string().nullable().optional()
      })
    )
    .default([])
});

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number())
    })
  )
});

export class OpenAICompatibleProvider implements LlmProvider {
  private readonly config: AppConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.fetchImpl = options.fetchImpl ?? createPolicyFetch(this.config.network);
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const response = await this.post("chat/completions", {
      model: req.model ?? this.config.llm.chatModel,
      messages: req.messages,
      temperature: req.temperature,
      stream: true
    });

    if (!response.body) {
      throw new LlmProviderError("LLM chat response did not include a stream.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    const reader = response.body.getReader();

    while (true) {
      const { done: readDone, value } = await reader.read();

      if (readDone) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const delta = parseChatStreamLine(line);

        if (delta === null) {
          continue;
        }

        done = delta.done === true || done;
        yield delta;
      }
    }

    buffer += decoder.decode();

    for (const line of buffer.split(/\r?\n/)) {
      const delta = parseChatStreamLine(line);

      if (delta !== null) {
        done = delta.done === true || done;
        yield delta;
      }
    }

    if (!done) {
      yield { done: true };
    }
  }

  async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) {
      return [];
    }

    const model = this.config.llm.embeddingModel ?? this.config.llm.chatModel;
    const response = await this.post("embeddings", {
      model,
      input
    });
    const body = embeddingResponseSchema.parse(await response.json());

    return body.data.map((item) => item.embedding);
  }

  private async post(pathname: string, body: unknown): Promise<Response> {
    const url = new URL(stripLeadingSlash(pathname), ensureTrailingSlash(this.config.llm.baseUrl));
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.llm.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new LlmProviderError(`LLM provider returned HTTP ${response.status}.`);
    }

    return response;
  }
}

export class LlmProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export type SafeErrorPayload = {
  name: string;
  message: string;
};

export function createLlmProvider(config = loadConfig()): LlmProvider {
  if (config.llm.provider !== "openai-compatible") {
    throw new LlmProviderError(`Unsupported LLM provider "${config.llm.provider}".`);
  }

  return new OpenAICompatibleProvider({ config });
}

export function redactError(error: unknown): SafeErrorPayload {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "Unknown LLM provider error.";

  return {
    name,
    message: redactSensitiveText(message)
  };
}

export function serializeSafeError(error: unknown): string {
  return JSON.stringify(redactError(error));
}

function parseChatStreamLine(line: string): ChatDelta | null {
  const trimmed = line.trim();

  if (trimmed === "" || trimmed.startsWith(":")) {
    return null;
  }

  const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;

  if (payload === "[DONE]") {
    return { done: true };
  }

  const chunk = chatChunkSchema.parse(JSON.parse(payload));
  const choice = chunk.choices[0];

  if (!choice) {
    return null;
  }

  const delta: ChatDelta = {};

  if (choice.delta.role) {
    delta.role = choice.delta.role;
  }

  if (choice.delta.content) {
    delta.content = choice.delta.content;
  }

  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    delta.done = true;
  }

  return Object.keys(delta).length > 0 ? delta : null;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}
