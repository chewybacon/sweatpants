import type { PiAiProviderOptions, PiAiImageProviderOptions } from "@sweatpan.ts/providers-pi-ai";
import { createProtocolRig } from "./protocol.ts";

/** Scripted SDK peer. Optional pause blocks before an event until replied to or aborted. */
export function createPiAiStreamRig(options: {
  readonly events: readonly unknown[];
  readonly result: unknown;
  readonly pauseAfter?: number;
}) {
  const peer = createProtocolRig();
  const requests: { model: PiAiProviderOptions["model"]; context: unknown; options: unknown }[] =
    [];
  const signals: AbortSignal[] = [];
  let released = 0;
  const stream: NonNullable<PiAiProviderOptions["stream"]> = (model, context, settings) => {
    if (!settings.signal) {
      throw new Error("SDK request requires scoped abort signal");
    }
    const signal = settings.signal;
    signals.push(signal);
    requests.push({
      model: structuredClone(model),
      context: structuredClone(context),
      options: { ...settings, signal: undefined, apiKey: undefined },
    });
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (let index = 0; index <= options.events.length; index++) {
            if (index === options.pauseAfter) {
              await peer.send({ id: "sdk", token: "next" }, signal);
            }
            if (index < options.events.length) {
              yield structuredClone(options.events[index]);
            }
          }
        } finally {
          await Promise.resolve();
          released++;
        }
      },
      async result() {
        return structuredClone(options.result);
      },
    };
  };
  return {
    stream,
    peer,
    requests,
    signals,
    get released() {
      return released;
    },
  };
}

/** Scripted image-generation peer with an optional pending operation for cancellation. */
export function createPiAiImageRig(result: unknown, pause = false) {
  const peer = createProtocolRig();
  const requests: { context: unknown }[] = [];
  const signals: AbortSignal[] = [];
  let released = 0;
  const generate: PiAiImageProviderOptions["generate"] = async (_model, context, options) => {
    if (!options.signal) {
      throw new Error("Image request requires scoped abort signal");
    }
    signals.push(options.signal);
    requests.push({
      context: structuredClone(context),
    });
    try {
      if (pause) {
        await peer.send({ id: "image", token: "generate" }, options.signal);
      }
      return structuredClone(result);
    } finally {
      released++;
    }
  };
  return {
    generate,
    peer,
    requests,
    signals,
    get released() {
      return released;
    },
  };
}
