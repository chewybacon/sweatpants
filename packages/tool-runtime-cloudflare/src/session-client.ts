import { call, resource, type Operation } from "effection";
import type {
  ToolInvocationResource,
  ToolInvocationResourceFactory,
  ToolSessionEvent,
} from "@sweatpants/tool-session";
import type { SessionMetadata, ToolSessionNamespace, ToolSessionRpc } from "./session-protocol.ts";

/** The host holds no live generator or transport subscription between requests. */
export function createCloudflareSessionResources(
  sessions: ToolSessionNamespace,
): ToolInvocationResourceFactory {
  function wrap(rpc: ToolSessionRpc, metadata: SessionMetadata): ToolInvocationResource {
    return {
      ...metadata,
      projection: {
        events(afterLSN = 0) {
          return resource(function* (provide) {
            const readerId = crypto.randomUUID();
            let cursor = afterLSN;
            try {
              yield* provide({
                *next(): Operation<IteratorResult<ToolSessionEvent, void>> {
                  const wire = yield* call(() => rpc.next(readerId, cursor));
                  const result = JSON.parse(wire) as IteratorResult<ToolSessionEvent, void>;
                  if (!result.done) cursor = result.value.lsn;
                  return result;
                },
              });
            } finally {
              yield* call(() => rpc.cancelRead(readerId));
            }
          });
        },
      },
      *resume(resume) {
        yield* call(() => rpc.resume(JSON.stringify(resume)));
      },
      *dispose() {
        yield* call(() => rpc.close());
      },
    };
  }
  return {
    *create(request) {
      const rpc = sessions.getByName(request.invocationId);
      const wire = yield* call(() =>
        rpc.start(
          JSON.stringify({
            invocationId: request.invocationId,
            toolName: request.tool.name,
            input: request.input,
            model: request.model,
          }),
        ),
      );
      return wrap(rpc, JSON.parse(wire) as SessionMetadata);
    },
    *open(id) {
      const rpc = sessions.getByName(id);
      const wire = yield* call(() => rpc.inspect());
      const metadata = JSON.parse(wire) as SessionMetadata | null;
      return metadata ? wrap(rpc, metadata) : null;
    },
  };
}
