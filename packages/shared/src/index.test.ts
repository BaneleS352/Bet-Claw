import { describe, expect, it } from "vitest";

import { healthResponseSchema, redactSensitiveText, redactSensitiveValue } from "./index.js";

describe("healthResponseSchema", () => {
  it("accepts the API health response shape", () => {
    expect(
      healthResponseSchema.parse({
        ok: true,
        service: "openclaw-api",
        uptimeSeconds: 1,
        timestamp: new Date().toISOString()
      })
    ).toMatchObject({ ok: true });
  });
});

describe("redaction helpers", () => {
  it("redacts common secret-bearing text patterns", () => {
    const redacted = redactSensitiveText(
      "Bearer sk-local-secret api_key=abc123 password: hunter2 https://user:pass@example.test"
    );

    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).toContain("password: [REDACTED]");
    expect(redacted).toContain("https://[REDACTED]@example.test");
    expect(redacted).not.toContain("sk-local-secret");
    expect(redacted).not.toContain("hunter2");
  });

  it("redacts sensitive object keys recursively", () => {
    expect(
      redactSensitiveValue({
        llm: {
          apiKey: "sk-local-secret",
          baseUrl: "http://127.0.0.1:11434/v1"
        },
        nested: [{ token: "abc123" }]
      })
    ).toEqual({
      llm: {
        apiKey: "[REDACTED]",
        baseUrl: "http://127.0.0.1:11434/v1"
      },
      nested: [{ token: "[REDACTED]" }]
    });
  });
});
