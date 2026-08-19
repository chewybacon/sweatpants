import { describe, expect, it } from "vitest";
import { parseTraceContext, projectTrustedHttpRequest } from "../index.ts";

describe("enterprise HTTP seams", () => {
  it("uses forwarded transport data only from explicitly trusted peers", () => {
    const request = new Request("http://internal/chat", {
      headers: {
        "x-forwarded-for": "203.0.113.8, 10.0.0.2",
        "x-forwarded-host": "agent.example.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(
      projectTrustedHttpRequest({
        request,
        immediatePeerAddress: "198.51.100.9",
        localScheme: "http",
        localHost: "internal",
        policy: { immediatePeerAddresses: ["10.0.0.2"] },
      }),
    ).toMatchObject({ clientAddress: "198.51.100.9", scheme: "http", host: "internal" });
    expect(
      projectTrustedHttpRequest({
        request,
        immediatePeerAddress: "10.0.0.2",
        localScheme: "http",
        localHost: "internal",
        policy: { immediatePeerAddresses: ["10.0.0.2"] },
      }),
    ).toMatchObject({
      clientAddress: "203.0.113.8",
      scheme: "https",
      host: "agent.example.test",
    });
  });

  it("accepts valid W3C trace context, rejects invalid context, and ignores baggage", () => {
    const valid = parseTraceContext(
      new Headers({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "vendor=value",
        baggage: "authorization=secret",
      }),
    );
    expect(valid).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    });
    expect(
      parseTraceContext(
        new Headers({
          traceparent: "00-00000000000000000000000000000000-0000000000000000-01",
        }),
      ),
    ).toEqual({});
  });
});
