import { z } from "zod";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("openclaw-api"),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime()
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const appConfigSchema = z.object({
  server: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535)
  }),
  llm: z.object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    chatModel: z.string().min(1),
    embeddingModel: z.string().min(1).optional()
  }),
  network: z.object({
    mode: z.literal("offline"),
    allowLoopback: z.boolean(),
    allowedHosts: z.array(z.string().min(1))
  }),
  workspace: z.object({
    root: z.string().min(1)
  }),
  agentOs: z.object({
    enabled: z.boolean(),
    heartbeatIntervalMs: z.number().int().min(100),
    jobsPerHeartbeat: z.number().int().min(0).max(50),
    jobRetryDelayMs: z.number().int().min(0)
  })
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type NetworkConfig = AppConfig["network"];

const sensitiveKeyPattern =
  /(?:api[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|session|token)/i;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9._~+/=-]+/gi, "Basic [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-[REDACTED]")
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[REDACTED]@")
    .replace(
      /\b(api[_-]?key|apiKey|authorization|cookie|credential|password|passwd|private[_-]?key|secret|session|token)(["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
      "$1$2[REDACTED]"
    )
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]");
}

export function redactSensitiveValue<T>(value: T): T {
  return redactValue(value) as T;
}

export function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redactValue(item)
      ])
    );
  }

  return value;
}
