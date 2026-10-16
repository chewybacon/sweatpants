import { StrictMode, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useChat } from "../src/index.ts";

function StrictWrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return <StrictMode>{children}</StrictMode>;
}

describe("owned React Chat lifecycle", () => {
  it("starts exactly one owned client through StrictMode double effects", async () => {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response(null, { status: 404 });
    };

    const mounted = renderHook(
      () =>
        useChat({
          threadId: "strict-mode-owned-client",
          api: "http://localhost/api/chat",
          fetcher,
        }),
      { wrapper: StrictWrapper },
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.method).toBe("POST");

    mounted.unmount();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(requests).toHaveLength(1);
  });
});
