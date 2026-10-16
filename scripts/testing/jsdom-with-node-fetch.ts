import { builtinEnvironments, type Environment } from "vitest/environments";

export default {
  name: "jsdom-with-node-fetch",
  transformMode: "web",
  async setup(global, options) {
    // jsdom provides the DOM but no fetch implementation. Keep Node's abort
    // constructors with its Request/fetch; Node 24 rejects jsdom's AbortSignal.
    // This environment combines DOM rendering with native HTTP, not all DOM
    // abort APIs: DOM addEventListener({ signal }) still requires a signal from
    // jsdom.window.AbortController. Vitest aliases the public window to global.
    const { AbortController, AbortSignal } = global;
    const environment = await builtinEnvironments.jsdom.setup(global, options);
    Object.assign(global, { AbortController, AbortSignal });
    // The builtin teardown restores the original Node globals after closing DOM.
    return environment;
  },
} satisfies Environment;
