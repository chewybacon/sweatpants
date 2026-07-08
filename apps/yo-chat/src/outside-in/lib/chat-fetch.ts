/**
 * Universal fetch seam for the outside-in HTTP test tier.
 *
 * The whole point of this tier (design R1/G1/G2) is that a single test body
 * drives the real chat stack through one `fetch(Request) -> Response` boundary,
 * regardless of whether the handler runs in-process (Tier A) or behind a real
 * booted server (Tier B).
 *
 * `ChatFetch` is the seam. A `ChatBinding` couples a `ChatFetch` with the
 * `baseUrl` the real client should target and a `close()` for teardown.
 */

export type ChatFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ChatBinding {
  /** Human label used in test names / diagnostics (e.g. "tier-a", "tier-b"). */
  readonly tier: string;
  /** The fetch seam the real client transport will call. */
  readonly fetch: ChatFetch;
  /** Base URL the real client session should POST to. */
  readonly baseUrl: string;
  /** Tear down any owned resources (handler scope, spawned server, ...). */
  close(): Promise<void>;
}

/**
 * Run `fn` with `globalThis.fetch` bound to `chatFetch`, restoring the original
 * afterward — even on throw. This is the encapsulated global-override strategy
 * from design Decision 1 (Option 1). The real client transport
 * (`api-transport.executeChatFetch`) calls the ambient `fetch`, so binding it
 * here keeps the real client path intact without any production changes.
 *
 * For Tier B the seam is just the real `fetch`, so this override is a no-op in
 * practice while keeping a single, uniform test code path.
 */
export async function withChatFetch<T>(chatFetch: ChatFetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = chatFetch as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Adapt a `Request -> Promise<Response>` handler (e.g. `ChatApplication.handle`)
 * into a `ChatFetch`. Mirrors the request reconstruction used by the existing
 * `tool-blackbox` outside-in test: strip the abort `signal` (in-process handlers
 * do not need it and some Request impls reject re-use) and rebuild a `Request`.
 */
export function handlerToChatFetch(handle: (request: Request) => Promise<Response>): ChatFetch {
  return async (input, init) => {
    const { signal: _signal, ...restInit } = init ?? {};
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handle(new Request(url, restInit));
  };
}
