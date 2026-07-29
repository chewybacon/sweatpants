export interface TrustedProxyPolicy {
  readonly immediatePeerAddresses: readonly string[];
  readonly forwardedForHeader?: string;
  readonly forwardedProtoHeader?: string;
  readonly forwardedHostHeader?: string;
}
export interface TrustedHttpProjection {
  readonly clientAddress: string;
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

/** Applies forwarded transport data only when the immediate peer is explicitly trusted. */
export function projectTrustedHttpRequest(input: {
  readonly request: Request;
  readonly immediatePeerAddress: string;
  readonly localScheme: "http" | "https";
  readonly localHost: string;
  readonly policy?: TrustedProxyPolicy;
}): TrustedHttpProjection {
  const trusted = Boolean(
    input.policy?.immediatePeerAddresses.includes(input.immediatePeerAddress),
  );
  const forwardedFor = trusted
    ? firstHeader(input.request, input.policy?.forwardedForHeader ?? "x-forwarded-for")
    : undefined;
  const forwardedProto = trusted
    ? firstHeader(input.request, input.policy?.forwardedProtoHeader ?? "x-forwarded-proto")
    : undefined;
  const forwardedHost = trusted
    ? firstHeader(input.request, input.policy?.forwardedHostHeader ?? "x-forwarded-host")
    : undefined;
  const trace = parseTraceContext(input.request.headers);
  return Object.freeze({
    clientAddress: forwardedFor ?? input.immediatePeerAddress,
    scheme:
      forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : input.localScheme,
    host: forwardedHost ?? input.localHost,
    ...(trace.traceparent ? { traceparent: trace.traceparent } : {}),
    ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
  });
}

/** Valid W3C trace context only; baggage is intentionally not propagated. */
export function parseTraceContext(headers: Headers): {
  readonly traceparent?: string;
  readonly tracestate?: string;
} {
  const traceparent = headers.get("traceparent")?.trim().toLowerCase();
  const validParent =
    traceparent &&
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent) &&
    !traceparent.includes("00000000000000000000000000000000") &&
    !traceparent.includes("-0000000000000000-")
      ? traceparent
      : undefined;
  const tracestateValue = headers.get("tracestate")?.trim();
  const tracestate =
    validParent &&
    tracestateValue &&
    tracestateValue.length <= 512 &&
    !/[\r\n]/.test(tracestateValue)
      ? tracestateValue
      : undefined;
  return Object.freeze({
    ...(validParent ? { traceparent: validParent } : {}),
    ...(tracestate ? { tracestate } : {}),
  });
}

function firstHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.split(",")[0]?.trim();
  return value || undefined;
}
