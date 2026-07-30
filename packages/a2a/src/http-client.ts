import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import { assertJson, canonicalJson, type Json } from "@sweatpants/foundation";
import {
  A2A_EXTENSIONS_HEADER,
  A2A_MAX_FRAME_BYTES,
  type A2ARequestAuthorization,
} from "./types.ts";
import { a2aError } from "./protocol.ts";
import { normalizedTransportOrigin, verifyA2AUrl, type A2AUrlPolicy } from "./url-policy.ts";

export interface A2AHttpResponse {
  readonly url: URL;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type A2AAuthorizationProvider = (
  url: URL,
  purpose: "agent-card" | "manifest",
) => Promise<A2ARequestAuthorization | undefined> | A2ARequestAuthorization | undefined;

export interface A2AHttpRequest {
  url: string | URL;
  purpose: "agent-card" | "manifest";
  method?: "GET" | "POST";
  body?: Json;
  headers?: Readonly<Record<string, string>>;
  cardOrigin?: string;
  activateExtension?: boolean;
  extensionUris?: readonly string[];
  policy?: A2AUrlPolicy;
  authorization?: A2AAuthorizationProvider;
  signal?: AbortSignal;
}
export interface A2AHttpClient {
  get(request: A2AHttpRequest): Promise<A2AHttpResponse>;
  request(request: A2AHttpRequest): Promise<A2AHttpResponse>;
}

/** Node HTTPS client that pins policy-approved DNS answers into the socket lookup. */
export function createSecureA2AHttpClient(): A2AHttpClient {
  const execute = async (request: A2AHttpRequest): Promise<A2AHttpResponse> => {
    const method = request.method ?? "GET";
    const maxRedirects = request.policy?.maxRedirects ?? 3;
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) {
      throw a2aError("unsafe_url", "A2A redirect limit must be between zero and three");
    }
    let current = request.url instanceof URL ? new URL(request.url) : new URL(request.url);
    let previous: URL | undefined;
    for (let redirects = 0; ; redirects += 1) {
      const validated = await verifyA2AUrl(current, {
        purpose: request.purpose,
        ...(request.policy ? { policy: request.policy } : {}),
        ...(request.cardOrigin ? { cardOrigin: request.cardOrigin } : {}),
        ...(previous ? { previousUrl: previous } : {}),
      });
      const authorization = await request.authorization?.(validated.url, request.purpose);
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/a2a+json" } : {}),
        ...(request.activateExtension
          ? { [A2A_EXTENSIONS_HEADER]: A2A_EXTENSION_HEADER_VALUE }
          : {}),
        ...(request.extensionUris?.length
          ? { [A2A_EXTENSIONS_HEADER]: request.extensionUris.join(",") }
          : {}),
        ...request.headers,
        ...authorization?.headers,
      };
      rejectUnsafeHeaders(headers);
      const response = await pinnedRequest(
        validated.url,
        validated.addresses,
        method,
        headers,
        request.body,
        request.signal,
      );
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }
      if (redirects >= maxRedirects) {
        throw a2aError("unsafe_url", "A2A redirect limit exceeded");
      }
      if (method === "POST" && ![307, 308].includes(response.status)) {
        throw a2aError("unsafe_url", "State-changing A2A redirects must preserve the HTTP method");
      }
      const location = response.headers["location"];
      if (!location) {
        throw a2aError("unsafe_url", "A2A redirect omitted Location");
      }
      previous = validated.url;
      current = new URL(location, validated.url);
      // Authorization is recalculated after policy validation for every redirect.
    }
  };
  return {
    get(request) {
      return execute({ ...request, method: "GET" });
    },
    request: execute,
  };
}

export function parseA2AJsonResponse(response: A2AHttpResponse): Json {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    return assertJson(JSON.parse(text));
  } catch {
    throw a2aError("agent_card_invalid", "A2A endpoint returned malformed JSON");
  }
}

export function requireExtensionEcho(response: A2AHttpResponse): void {
  const value = response.headers[A2A_EXTENSIONS_HEADER.toLowerCase()];
  const activated = value?.split(",").map((part) => part.trim());
  if (!activated?.includes(A2A_EXTENSION_HEADER_VALUE)) {
    throw a2aError("extension_echo_mismatch", "A2A extension activation was not echoed");
  }
}

export function jsonHttpBody(value: Json): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

const A2A_EXTENSION_HEADER_VALUE =
  "https://github.com/chewybacon/sweatpants/blob/main/protocols/a2a/caller-authoritative-program/v1/spec.md";

function pinnedRequest(
  url: URL,
  addresses: readonly string[],
  method: "GET" | "POST",
  headers: Readonly<Record<string, string>>,
  body?: Json,
  signal?: AbortSignal,
): Promise<A2AHttpResponse> {
  const encodedBody = body === undefined ? undefined : canonicalJson(body);
  if (
    encodedBody !== undefined &&
    new TextEncoder().encode(encodedBody).byteLength > A2A_MAX_FRAME_BYTES
  ) {
    return Promise.reject(a2aError("payload_too_large", "A2A HTTP request exceeds 2 MiB"));
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(a2aError("transport_lost", "A2A HTTP request aborted"));
      return;
    }
    const lookup = createPinnedLookup(addresses);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method,
      headers,
      lookup,
      signal,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    });
    request.once("error", (error) =>
      reject(a2aError("transport_lost", "A2A HTTP transport lost", error)),
    );
    request.once("response", (incoming) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > A2A_MAX_FRAME_BYTES) {
          incoming.destroy(a2aError("payload_too_large", "A2A HTTP response exceeds 2 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.once("error", reject);
      incoming.once("end", () => {
        const normalized: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) {
            normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
        }
        resolve({
          url,
          status: incoming.statusCode ?? 0,
          headers: Object.freeze(normalized),
          body: new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
        });
      });
    });
    if (encodedBody !== undefined) {
      request.write(encodedBody);
    }
    request.end();
  });
}

function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    const records = addresses.map((address) => ({ address, family: isIP(address) }));
    if (options?.all) {
      callback(null, records);
    } else {
      callback(null, records[0]?.address, records[0]?.family);
    }
  }) as LookupFunction;
}

function rejectUnsafeHeaders(headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (["host", "connection", "upgrade", "content-length"].includes(lower)) {
      throw a2aError("authentication_failed", `Authorization provider may not set ${name}`);
    }
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
      throw a2aError("authentication_failed", "Invalid authorization header");
    }
  }
}

export function sameA2AOrigin(left: string | URL, right: string | URL): boolean {
  return normalizedTransportOrigin(left) === normalizedTransportOrigin(right);
}
