/**
 * Tier B binding (design R3 / Decision 3).
 *
 * Targets the real booted app server over real HTTP at `<url>/api/chat`. The
 * seam is just the real `fetch`; the same test body and same assertions as Tier
 * A run here, adding full-wiring fidelity (vite `?modulePath` worker bundling +
 * SSR) for near-zero extra test code.
 */
import { ensureSharedServer } from "./server-fixture.ts";
import type { ChatBinding } from "./chat-fetch.ts";

/**
 * Create a Tier B binding against the shared (booted or reused) server. The
 * binding's `close()` is a no-op: server lifecycle is owned by the shared
 * fixture / globalSetup, not by any single flow.
 */
export async function createTierBBinding(): Promise<ChatBinding> {
  const server = await ensureSharedServer();
  // Capture the real fetch once; Tier B always talks to the server over HTTP.
  const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
  return {
    tier: "tier-b",
    fetch: (input, init) => {
      let url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      // Resolve relative Chat Client transport URLs against the server URL.
      if (url.startsWith("/")) {
        url = `${server.url.replace(/\/$/, "")}${url}`;
      }
      return realFetch(url as RequestInfo | URL, init);
    },
    baseUrl: `${server.url.replace(/\/$/, "")}/api/chat`,
    async close() {
      // Shared server is torn down by globalSetup/teardown, not per-binding.
    },
  };
}
