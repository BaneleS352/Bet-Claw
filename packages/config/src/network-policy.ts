import type { NetworkConfig } from "@openclaw/shared";

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

export function assertUrlAllowed(url: string | URL, policy: NetworkConfig): void {
  const target = parseHttpUrl(url);
  const hostname = target.hostname.toLowerCase();

  if (policy.mode !== "offline") {
    throw new NetworkPolicyError("Only offline network mode is supported in v1.");
  }

  if (policy.allowLoopback && isLoopbackHost(hostname)) {
    return;
  }

  if (policy.allowedHosts.map((host) => host.toLowerCase()).includes(hostname) && isPrivateLanHost(hostname)) {
    return;
  }

  throw new NetworkPolicyError(`Outbound HTTP to "${hostname}" is blocked by offline network policy.`);
}

export function isUrlAllowed(url: string | URL, policy: NetworkConfig): boolean {
  try {
    assertUrlAllowed(url, policy);
    return true;
  } catch (error) {
    if (error instanceof NetworkPolicyError) {
      return false;
    }

    throw error;
  }
}

export function createPolicyFetch(policy: NetworkConfig, fetchImpl: typeof fetch = fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const targetUrl = typeof input === "string" || input instanceof URL ? input : input.url;
    try {
      assertUrlAllowed(targetUrl, policy);
    } catch (error) {
      return Promise.reject(error);
    }

    return fetchImpl(input, {
      ...init,
      redirect: "manual"
    });
  }) as typeof fetch;
}

export function assertLocalServerBindAllowed(host: string): void {
  if (!isLoopbackHost(host.toLowerCase())) {
    throw new NetworkPolicyError(`Server bind host "${host}" is blocked; v1 only binds locally.`);
  }
}

function parseHttpUrl(url: string | URL): URL {
  const target = typeof url === "string" ? new URL(url) : url;

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new NetworkPolicyError(`Protocol "${target.protocol}" is blocked by offline network policy.`);
  }

  return target;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || isLoopbackIpv4(hostname);
}

function isLoopbackIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname);

  return octets !== null && octets[0] === 127;
}

function isPrivateLanHost(hostname: string): boolean {
  const octets = parseIpv4(hostname);

  if (octets === null) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));

  if (
    octets.some(
      (octet, index) =>
        Number.isNaN(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== parts[index]
    )
  ) {
    return null;
  }

  return octets as [number, number, number, number];
}
