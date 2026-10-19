import { call, type Operation } from "effection";
import {
  StaleTokenWriterError,
  type TokenBuffer,
  type TokenBufferStore,
  type SessionRegistryStore,
} from "@sweatpants/durable-streams";
import type { Reply, ResponseStreamNamespace, BufferState } from "./protocol.ts";
export type { ResponseStreamNamespace } from "./protocol.ts";

function* invoke<T>(operation: () => Promise<Reply<T>>): Operation<T> {
  const reply = yield* call(operation);
  if (reply.ok) {
    return reply.value;
  }
  if (reply.code === "stale_token_writer") {
    throw new StaleTokenWriterError(reply.message);
  }
  throw new Error(reply.message);
}

/** Adapts a caller-owned DO namespace to the existing response-delivery ports. */
export function createCloudflareResponseStores<T>(namespace: ResponseStreamNamespace): {
  bufferStore: TokenBufferStore<T>;
  registryStore: SessionRegistryStore;
} {
  function buffer(id: string): TokenBuffer<T> {
    const remote = namespace.getByName(id);
    function* state(): Operation<BufferState> {
      const value = yield* invoke(() => remote.bufferState());
      if (!value) {
        throw new Error(`Response buffer ${id} does not exist`);
      }
      return value;
    }
    return {
      id,
      *claimWriter(fence) {
        yield* invoke(() => remote.claim(fence));
        return {
          fence: { streamId: id, ...fence },
          *append(tokens) {
            const encoded = tokens.map((token) => {
              const value = JSON.stringify(token);
              if (value === undefined) {
                throw new Error("Response tokens must be JSON serializable");
              }
              return value;
            });
            return yield* invoke(() => remote.append(fence, encoded));
          },
          *complete() {
            yield* invoke(() => remote.closeBuffer(fence, null));
          },
          *fail(error) {
            yield* invoke(() =>
              remote.closeBuffer(fence, { name: error.name, message: error.message }),
            );
          },
        };
      },
      *read(after = 0, limit) {
        const value = yield* invoke(() => remote.read(after, limit ?? null));
        return { tokens: value.tokens.map((token) => JSON.parse(token) as T), lsn: value.lsn };
      },
      *readLatest() {
        const value = yield* invoke(() => remote.latest());
        return {
          token: value.token === null ? undefined : (JSON.parse(value.token) as T),
          lsn: value.lsn,
        };
      },
      *isComplete() {
        return (yield* state()).complete;
      },
      *getError() {
        const { error } = yield* state();
        return error ? Object.assign(new Error(error.message), { name: error.name }) : null;
      },
      *waitForChange(after) {
        while (true) {
          const value = yield* state();
          if (value.lsn > after || value.complete) {
            return;
          }
          const readerId = crypto.randomUUID();
          try {
            yield* invoke(() => remote.waitForChange(readerId, after));
          } finally {
            yield* invoke(() => remote.cancelWait(readerId));
          }
        }
      },
    };
  }
  return {
    bufferStore: {
      *create(id) {
        yield* invoke(() => namespace.getByName(id).createBuffer());
        return buffer(id);
      },
      *get(id) {
        return (yield* invoke(() => namespace.getByName(id).bufferState())) ? buffer(id) : null;
      },
      *delete(id) {
        yield* invoke(() => namespace.getByName(id).removeBuffer());
      },
    },
    registryStore: {
      *get(id) {
        return yield* invoke(() => namespace.getByName(id).getEntry());
      },
      *set(id, entry) {
        yield* invoke(() => namespace.getByName(id).setEntry(entry));
      },
      *delete(id) {
        yield* invoke(() => namespace.getByName(id).removeEntry());
      },
      *updateRefCount(id, delta) {
        return yield* invoke(() => namespace.getByName(id).updateRefCount(delta));
      },
    },
  };
}
