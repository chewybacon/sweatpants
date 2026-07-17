import type { Operation } from "effection";
import type {
  DurableProgramManifest,
  DurableToolRegistry,
  PinnedProgram,
} from "@sweatpants/session-contract";
import type { A2AWebSocketConnector } from "./connector.ts";
import type { A2AExecutorPrincipal, A2AProgramExecutor } from "./executor.ts";
import { CALLER_AUTHORITATIVE_EXTENSION_URI } from "./types.ts";
import { a2aError } from "./protocol.ts";
import { createRemoteProgramManifestDocument } from "./server.ts";

/** Processless connector for provider-neutral ProgramDriver conformance fixtures. */
export function createInProcessA2AConnector(
  executor: A2AProgramExecutor,
  principal: A2AExecutorPrincipal = { principalId: "a2a-conformance" },
): A2AWebSocketConnector {
  return {
    *connect(request) {
      if (request.signal.aborted) throw a2aError("transport_lost", "A2A test connection aborted");
      const remote = executor.openConnection({
        principal,
        activatedExtension: CALLER_AUTHORITATIVE_EXTENSION_URI,
      });
      const responses: Array<string | Uint8Array> = [remote.hello];
      let closed = false;
      return {
        *send(frame): Operation<void> {
          if (closed) throw a2aError("transport_lost", "A2A test connection is closed");
          const response = yield* remote.handle(frame);
          if (response !== undefined) responses.push(response);
        },
        *receive(): Operation<string | Uint8Array> {
          if (closed) throw a2aError("transport_lost", "A2A test connection is closed");
          const response = responses.shift();
          if (response === undefined)
            throw a2aError("transport_lost", "A2A test connection has no pending response");
          return response;
        },
        *close(): Operation<void> {
          if (closed) return;
          closed = true;
          yield* remote.close();
        },
      };
    },
  };
}

export function createRegistryManifestProvider(
  registry: DurableToolRegistry,
  streamedRestore = true,
): (program: PinnedProgram) => Promise<ReturnType<typeof createRemoteProgramManifestDocument>> {
  return async (program) => {
    const tool = registry.get(`${program.id}@${program.version}#${program.digest}`);
    if (!tool) throw a2aError("program_version_unavailable", "Exact remote program is unavailable");
    return createRemoteProgramManifestDocument(tool.manifest as DurableProgramManifest, {
      streamedRestore,
    });
  };
}

export {
  runForeignA2AConformance,
  type ForeignA2AConformanceEvidence,
  type ForeignA2AConformanceFactory,
  type ForeignA2AConformanceScenario,
} from "./foreign-testing.ts";

export {
  DURABLE_DRIVER_FIXTURE_SCHEMA_ENTRIES,
  DURABLE_DRIVER_FIXTURE_TOOLS,
  durableDriverCancellationFixtureTool,
  durableDriverRecoveryFixtureTool,
  runDurableDriverCancellationFixture,
  runDurableDriverRecoveryFixture,
} from "@sweatpants/session-contract/testing";
