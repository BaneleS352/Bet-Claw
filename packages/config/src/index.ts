import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

import { appConfigSchema, type AppConfig } from "@openclaw/shared";

import { assertLocalServerBindAllowed, assertUrlAllowed } from "./network-policy.js";

dotenv.config();

type PartialConfig = {
  server?: {
    host?: string;
    port?: number;
  };
  llm?: {
    provider?: "openai-compatible";
    baseUrl?: string;
    apiKey?: string;
    chatModel?: string;
    embeddingModel?: string;
  };
  network?: {
    mode?: "offline";
    allowLoopback?: boolean;
    allowedHosts?: string[];
  };
  workspace?: {
    root?: string;
  };
  agentOs?: {
    enabled?: boolean;
    heartbeatIntervalMs?: number;
    jobsPerHeartbeat?: number;
    jobRetryDelayMs?: number;
  };
};

export const defaultConfig: AppConfig = {
  server: {
    host: "127.0.0.1",
    port: 3001
  },
  llm: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "local-development-key",
    chatModel: "local-chat"
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
    enabled: true,
    heartbeatIntervalMs: 30_000,
    jobsPerHeartbeat: 5,
    jobRetryDelayMs: 60_000
  }
};

export type LoadConfigOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configFile?: string;
};

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configFile = options.configFile ?? env.OPENCLAW_CONFIG_FILE ?? "openclaw.config.json";

  const fromFile = loadLocalConfig(cwd, configFile);
  const fromEnv = loadEnvConfig(env);
  const config = appConfigSchema.parse(mergeConfig(defaultConfig, fromFile, fromEnv));

  assertLocalServerBindAllowed(config.server.host);
  assertUrlAllowed(config.llm.baseUrl, config.network);

  return config;
}

function loadLocalConfig(cwd: string, configFile: string): PartialConfig {
  const resolvedPath = path.isAbsolute(configFile) ? configFile : path.resolve(cwd, configFile);

  if (!existsSync(resolvedPath)) {
    return {};
  }

  return JSON.parse(readFileSync(resolvedPath, "utf8")) as PartialConfig;
}

function loadEnvConfig(env: NodeJS.ProcessEnv): PartialConfig {
  return {
    server: stripUndefined({
      host: env.OPENCLAW_SERVER_HOST ?? env.OPENCLAW_API_HOST,
      port: parseOptionalPort(env.OPENCLAW_SERVER_PORT ?? env.OPENCLAW_API_PORT)
    }),
    llm: stripUndefined({
      provider: parseLlmProvider(env.OPENCLAW_LLM_PROVIDER),
      baseUrl: env.OPENCLAW_LLM_BASE_URL,
      apiKey: env.OPENCLAW_LLM_API_KEY,
      chatModel: env.OPENCLAW_LLM_CHAT_MODEL,
      embeddingModel: env.OPENCLAW_LLM_EMBEDDING_MODEL
    }),
    network: stripUndefined({
      mode: parseNetworkMode(env.OPENCLAW_NETWORK_MODE),
      allowLoopback: parseOptionalBoolean(env.OPENCLAW_NETWORK_ALLOW_LOOPBACK),
      allowedHosts: parseOptionalList(env.OPENCLAW_NETWORK_ALLOWED_HOSTS)
    }),
    workspace: stripUndefined({
      root: env.OPENCLAW_WORKSPACE_ROOT
    }),
    agentOs: stripUndefined({
      enabled: parseOptionalBoolean(env.OPENCLAW_AGENT_OS_ENABLED),
      heartbeatIntervalMs: parseOptionalInteger(env.OPENCLAW_AGENT_OS_HEARTBEAT_INTERVAL_MS),
      jobsPerHeartbeat: parseOptionalInteger(env.OPENCLAW_AGENT_OS_JOBS_PER_HEARTBEAT),
      jobRetryDelayMs: parseOptionalInteger(env.OPENCLAW_AGENT_OS_JOB_RETRY_DELAY_MS)
    })
  };
}

function mergeConfig(...configs: PartialConfig[]): PartialConfig {
  return configs.reduce<PartialConfig>(
    (merged, next) => ({
      server: { ...merged.server, ...next.server },
      llm: { ...merged.llm, ...next.llm },
      network: { ...merged.network, ...next.network },
      workspace: { ...merged.workspace, ...next.workspace },
      agentOs: { ...merged.agentOs, ...next.agentOs }
    }),
    {}
  );
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return Number.parseInt(value, 10);
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return Number.parseInt(value, 10);
}

function parseOptionalList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseLlmProvider(value: string | undefined): "openai-compatible" | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value as "openai-compatible";
}

function parseNetworkMode(value: string | undefined): "offline" | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value as "offline";
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

export {
  NetworkPolicyError,
  assertLocalServerBindAllowed,
  assertUrlAllowed,
  createPolicyFetch,
  isUrlAllowed
} from "./network-policy.js";
