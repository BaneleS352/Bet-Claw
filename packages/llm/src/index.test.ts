import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider, redactError } from "./index.js";
import type { AppConfig } from "@openclaw/shared";

const config: AppConfig = {
  server: {
    host: "127.0.0.1",
    port: 3001
  },
  llm: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "sk-local-secret",
    chatModel: "local-chat",
    embeddingModel: "local-embedding"
  },
  network: {
    mode: "offline",
    allowLoopback: true,
    allowedHosts: ["127.0.0.1", "localhost"]
  },
  workspace: {
    root: "."
  },
  agentOs: {
    enabled: false,
    heartbeatIntervalMs: 30_000,
    jobsPerHeartbeat: 5,
    jobRetryDelayMs: 1_000
  }
};

describe("OpenAICompatibleProvider", () => {
  it("streams chat deltas from an OpenAI-compatible SSE response", async () => {
    const provider = new OpenAICompatibleProvider({
      config,
      fetchImpl: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
            "data: [DONE]"
          ].join("\n"),
          { status: 200 }
        )
    });

    const deltas = [];

    for await (const delta of provider.streamChat({ messages: [{ role: "user", content: "Hi" }] })) {
      deltas.push(delta);
    }

    expect(deltas).toEqual([
      { role: "assistant", content: "Hel" },
      { content: "lo" },
      { done: true }
    ]);
  });

  it("returns embeddings from the configured provider", async () => {
    const provider = new OpenAICompatibleProvider({
      config,
      fetchImpl: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "local-embedding",
          input: ["one", "two"]
        });

        return Response.json({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }]
        });
      }
    });

    await expect(provider.embed(["one", "two"])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4]
    ]);
  });

  it("redacts provider errors before persistence", () => {
    expect(redactError(new Error("Bearer sk-local-secret api_key=abc123"))).toEqual({
      name: "Error",
      message: "Bearer [REDACTED] api_key=[REDACTED]"
    });
  });
});
