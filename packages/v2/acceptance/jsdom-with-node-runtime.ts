import { builtinEnvironments, type Environment } from "vitest/environments";

export default {
  name: "jsdom-with-node-runtime",
  transformMode: "web",
  async setup(global, options) {
    // The DOM consumer shares a process with the real Node host. Keep the Node
    // constructors used by its abort signals and v8-serialized Buffer frames.
    const { AbortController, AbortSignal, Uint8Array } = global;
    const environment = await builtinEnvironments.jsdom.setup(global, options);
    Object.assign(global, { AbortController, AbortSignal, Uint8Array });
    return environment;
  },
} satisfies Environment;
