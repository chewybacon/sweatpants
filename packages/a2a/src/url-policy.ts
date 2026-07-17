import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { a2aError } from "./protocol.ts";

export type A2AUrlPurpose = "agent-card" | "manifest" | "driver";

export interface A2AUrlPolicy {
  readonly allowLocalhostTests?: boolean;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly maxRedirects?: number;
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

export interface ValidatedA2AUrl {
  readonly url: URL;
  readonly addresses: readonly string[];
  readonly localhostException: boolean;
}

/** Validates scheme, origin and every resolved address before network I/O. */
export async function validateA2AUrl(
  value: string | URL,
  options: {
    purpose: A2AUrlPurpose;
    policy?: A2AUrlPolicy;
    cardOrigin?: string;
    previousUrl?: URL;
  },
): Promise<ValidatedA2AUrl> {
  const policy = options.policy ?? {};
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch (error) {
    throw a2aError("unsafe_url", "A2A endpoint is not an absolute URL", error);
  }
  const expected = options.purpose === "driver" ? "wss:" : "https:";
  const localhostException =
    Boolean(policy.allowLocalhostTests) &&
    isLoopbackHostname(url.hostname) &&
    ((options.purpose === "driver" && url.protocol === "ws:") ||
      (options.purpose !== "driver" && url.protocol === "http:"));
  if (url.protocol !== expected && !localhostException) {
    throw a2aError("unsafe_url", `A2A ${options.purpose} endpoint must use ${expected}`);
  }
  if (url.username || url.password)
    throw a2aError("unsafe_url", "Credentials are forbidden in A2A URLs");
  if (url.hash) throw a2aError("unsafe_url", "Fragments are forbidden in A2A endpoint URLs");
  if (options.previousUrl?.protocol === "https:" && url.protocol !== "https:") {
    throw a2aError("unsafe_url", "HTTPS downgrade is forbidden");
  }

  const allowedOrigins = new Set((policy.allowedOrigins ?? []).map(normalizeOrigin));
  if (options.cardOrigin) {
    const endpointOrigin = normalizedTransportOrigin(url);
    const cardOrigin = normalizeOrigin(options.cardOrigin);
    if (endpointOrigin !== cardOrigin && !allowedOrigins.has(endpointOrigin)) {
      throw a2aError("unsafe_url", "A2A extension endpoint must share the Agent Card origin");
    }
  }

  const allowedHosts = new Set((policy.allowedHosts ?? []).map((host) => host.toLowerCase()));
  const resolve = policy.resolve ?? defaultResolve;
  const addresses = await resolve(stripBrackets(url.hostname));
  if (addresses.length === 0)
    throw a2aError("unsafe_url", "A2A endpoint DNS returned no addresses");
  for (const address of addresses) {
    if (!isSafePublicAddress(address)) {
      const hostAllowed = allowedHosts.has(stripBrackets(url.hostname).toLowerCase());
      if (!(localhostException && isLoopbackAddress(address)) && !hostAllowed) {
        throw a2aError("unsafe_url", "A2A endpoint resolved to a disallowed network");
      }
    }
  }
  return Object.freeze({ url, addresses: Object.freeze([...addresses]), localhostException });
}

export function normalizedTransportOrigin(value: URL | string): string {
  const url = value instanceof URL ? value : new URL(value);
  const protocol =
    url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  const defaultPort = protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
  const port = url.port || defaultPort;
  return `${protocol}//${url.hostname.toLowerCase()}${port === defaultPort ? "" : `:${port}`}`;
}

export function isSafePublicAddress(address: string): boolean {
  const normalized = stripZone(address).toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return isSafeIpv4(normalized);
  if (version === 6) {
    const mapped = mappedIpv4(normalized);
    if (mapped) return isSafeIpv4(mapped);
    return isSafeIpv6(normalized);
  }
  return false;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = stripZone(address).toLowerCase();
  if (isIP(normalized) === 4) return inIpv4Cidr(normalized, "127.0.0.0", 8);
  if (normalized === "::1") return true;
  const mapped = mappedIpv4(normalized);
  return Boolean(mapped && inIpv4Cidr(mapped, "127.0.0.0", 8));
}

function isSafeIpv4(address: string): boolean {
  const denied: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !denied.some(([network, bits]) => inIpv4Cidr(address, network, bits));
}

function isSafeIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === undefined) return false;
  const denied: Array<[string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  return !denied.some(([network, bits]) => inIpv6Cidr(value, network, bits));
}

function inIpv4Cidr(address: string, network: string, bits: number): boolean {
  const a = ipv4Number(address);
  const n = ipv4Number(network);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (n & mask);
}
function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}
function inIpv6Cidr(value: bigint, network: string, bits: number): boolean {
  const base = ipv6ToBigInt(network);
  if (base === undefined) return false;
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}
function ipv6ToBigInt(address: string): bigint | undefined {
  const stripped = stripZone(address);
  const mapped = mappedIpv4(stripped);
  let source = stripped;
  if (mapped) {
    const n = ipv4Number(mapped);
    source =
      source.slice(0, source.lastIndexOf(":")) +
      `:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const pieces = source.split("::");
  if (pieces.length > 2) return undefined;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return undefined;
  return words.reduce((value, word) => (value << 16n) | BigInt(parseInt(word, 16)), 0n);
}
function mappedIpv4(address: string): string | undefined {
  const match = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match?.[1];
}
function stripZone(address: string): string {
  return address.split("%")[0] ?? address;
}
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
function isLoopbackHostname(hostname: string): boolean {
  const host = stripBrackets(hostname).toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || isLoopbackAddress(host);
}
function normalizeOrigin(value: string): string {
  return normalizedTransportOrigin(new URL(value));
}
async function defaultResolve(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  try {
    const records = await nodeLookup(hostname, { all: true, verbatim: true });
    return [...new Set(records.map((record) => record.address))];
  } catch (error) {
    throw a2aError("unsafe_url", "A2A endpoint DNS resolution failed", error);
  }
}
