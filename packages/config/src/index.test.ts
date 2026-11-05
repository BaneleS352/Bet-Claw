import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("loads defaults when no file or env overrides exist", () => {
    const config = loadConfig({ env: {}, configFile: "missing.json" });

    expect(config.server.port).toBe(3001);
    expect(config.network.mode).toBe("offline");
    expect(config.network.allowedHosts).toContain("localhost");
    expect(config.agentOs.heartbeatIntervalMs).toBe(30_000);
  });

  it("merges local file and env with env taking precedence", () => {
    const cwd = join(tmpdir(), `openclaw-config-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "openclaw.config.json"), JSON.stringify({ server: { port: 4000 } }));

    try {
      const config = loadConfig({
        cwd,
        env: {
          OPENCLAW_SERVER_PORT: "5000",
          OPENCLAW_WORKSPACE_ROOT: "./tmp",
          OPENCLAW_AGENT_OS_ENABLED: "false",
          OPENCLAW_AGENT_OS_JOBS_PER_HEARTBEAT: "2"
        }
      });

      expect(config.server.port).toBe(5000);
      expect(config.workspace.root).toBe("./tmp");
      expect(config.agentOs.enabled).toBe(false);
      expect(config.agentOs.jobsPerHeartbeat).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an LLM base URL that violates the offline policy", () => {
    expect(() =>
      loadConfig({
        env: {
          OPENCLAW_LLM_BASE_URL: "https://api.openai.com/v1"
        },
        configFile: "missing.json"
      })
    ).toThrow(/blocked by offline network policy/);
  });

  it("validates required local OpenAI-compatible LLM config", () => {
    const cwd = join(tmpdir(), `openclaw-config-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "openclaw.config.json"),
      JSON.stringify({
        llm: {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "",
          chatModel: ""
        }
      })
    );

    try {
      expect(() =>
        loadConfig({
          cwd,
          env: {}
        })
      ).toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows an allowlisted private LAN LLM host", () => {
    const config = loadConfig({
      env: {
        OPENCLAW_LLM_BASE_URL: "http://192.168.1.40:11434/v1",
        OPENCLAW_NETWORK_ALLOWED_HOSTS: "192.168.1.40"
      },
      configFile: "missing.json"
    });

    expect(config.llm.baseUrl).toBe("http://192.168.1.40:11434/v1");
  });

  it("rejects non-local API bind hosts", () => {
    expect(() =>
      loadConfig({
        env: {
          OPENCLAW_SERVER_HOST: "0.0.0.0"
        },
        configFile: "missing.json"
      })
    ).toThrow(/only binds locally/);
  });
});
