import { describe, expect, it } from "vitest";

import type { NetworkConfig } from "@openclaw/shared";

import { assertLocalServerBindAllowed, createPolicyFetch, isUrlAllowed } from "./network-policy.js";

const policy: NetworkConfig = {
  mode: "offline",
  allowLoopback: true,
  allowedHosts: ["127.0.0.1", "localhost", "192.168.1.50"]
};

describe("network policy", () => {
  it("allows loopback hosts", () => {
    expect(isUrlAllowed("http://127.0.0.1:11434/v1", policy)).toBe(true);
    expect(isUrlAllowed("http://localhost:11434/v1", policy)).toBe(true);
  });

  it("allows allowlisted private LAN hosts", () => {
    expect(isUrlAllowed("http://192.168.1.50:11434/v1", policy)).toBe(true);
  });

  it("denies public IPs and arbitrary DNS names", () => {
    expect(isUrlAllowed("https://1.1.1.1/v1", policy)).toBe(false);
    expect(isUrlAllowed("https://example.com/v1", policy)).toBe(false);
  });

  it("blocks before fetch executes", async () => {
    const fetchImpl = (() => {
      throw new Error("fetch should not run");
    }) as typeof fetch;
    const policyFetch = createPolicyFetch(policy, fetchImpl);

    await expect(policyFetch("https://example.com")).rejects.toThrow(/blocked by offline network policy/);
  });

  it("forces manual redirects so allowed hosts cannot bounce to public internet", async () => {
    const fetchImpl = ((_input, init) => {
      expect(init?.redirect).toBe("manual");

      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    const policyFetch = createPolicyFetch(policy, fetchImpl);

    await expect(policyFetch("http://127.0.0.1:11434/v1", { redirect: "follow" })).resolves.toBeInstanceOf(
      Response
    );
  });

  it("rejects non-local API bind hosts", () => {
    expect(() => assertLocalServerBindAllowed("0.0.0.0")).toThrow(/only binds locally/);
    expect(() => assertLocalServerBindAllowed("127.0.0.1")).not.toThrow();
  });
});
