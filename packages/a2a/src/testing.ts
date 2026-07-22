import { call, type Operation } from "effection";
import type { ForeignA2AClientPort } from "./foreign-client.ts";
import type {
  ForeignA2AContinueRequest,
  ForeignA2ASendResult,
  ForeignA2AStartRequest,
  ForeignA2ATask,
} from "./foreign-task-types.ts";
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

export interface PendingForeignA2ARequest<I, O> {
  readonly request: I;
  respond(value: O): Operation<void>;
  fail(error: Error): Operation<void>;
}

interface Mailbox<I, O> {
  submit(request: I): Operation<O>;
  next(): Operation<PendingForeignA2ARequest<I, O>>;
  outstanding(): { arrivals: number; consumers: number; responses: number };
}

function mailbox<I, O>(): Mailbox<I, O> {
  const arrivals: Array<PendingForeignA2ARequest<I, O>> = [];
  const consumers: Array<(pending: PendingForeignA2ARequest<I, O>) => void> = [];
  let responses = 0;
  return {
    *submit(request) {
      return yield* call(
        () =>
          new Promise<O>((resolve, reject) => {
            responses += 1;
            let settled = false;
            const pending: PendingForeignA2ARequest<I, O> = {
              request,
              *respond(value) {
                if (settled) throw new Error("Foreign A2A request was already answered");
                settled = true;
                responses -= 1;
                resolve(value);
              },
              *fail(error) {
                if (settled) throw new Error("Foreign A2A request was already answered");
                settled = true;
                responses -= 1;
                reject(error);
              },
            };
            const consumer = consumers.shift();
            if (consumer) consumer(pending);
            else arrivals.push(pending);
          }),
      );
    },
    *next() {
      const arrived = arrivals.shift();
      if (arrived) return arrived;
      return yield* call(
        () =>
          new Promise<PendingForeignA2ARequest<I, O>>((resolve) => {
            consumers.push(resolve);
          }),
      );
    },
    outstanding: () => ({ arrivals: arrivals.length, consumers: consumers.length, responses }),
  };
}

export interface ControllableForeignA2AAgent {
  readonly client: ForeignA2AClientPort;
  nextInitial(): Operation<PendingForeignA2ARequest<ForeignA2AStartRequest, ForeignA2ASendResult>>;
  nextContinuation(): Operation<
    PendingForeignA2ARequest<ForeignA2AContinueRequest, ForeignA2ASendResult>
  >;
  nextObservation(): Operation<PendingForeignA2ARequest<{ taskId: string }, ForeignA2ATask>>;
  nextCancellation(): Operation<PendingForeignA2ARequest<{ taskId: string }, ForeignA2ATask>>;
  verify(): void;
}

/** Semantic, buffered foreign-agent boundary for causal scenario tests. */
export function createControllableForeignA2AAgent(): ControllableForeignA2AAgent {
  const initial = mailbox<ForeignA2AStartRequest, ForeignA2ASendResult>();
  const continuation = mailbox<ForeignA2AContinueRequest, ForeignA2ASendResult>();
  const observation = mailbox<{ taskId: string }, ForeignA2ATask>();
  const cancellation = mailbox<{ taskId: string }, ForeignA2ATask>();
  return {
    client: {
      *sendInitial(request) {
        return yield* initial.submit(request);
      },
      *sendContinuation(request) {
        return yield* continuation.submit(request);
      },
      *getTask(request) {
        return yield* observation.submit({ taskId: request.taskId });
      },
      *cancelTask(request) {
        return yield* cancellation.submit({ taskId: request.taskId });
      },
    },
    nextInitial: () => initial.next(),
    nextContinuation: () => continuation.next(),
    nextObservation: () => observation.next(),
    nextCancellation: () => cancellation.next(),
    verify() {
      const outstanding = [
        ["initial", initial.outstanding()],
        ["continuation", continuation.outstanding()],
        ["observation", observation.outstanding()],
        ["cancellation", cancellation.outstanding()],
      ] as const;
      const leaks = outstanding.flatMap(([name, counts]) =>
        Object.entries(counts).flatMap(([kind, count]) =>
          count > 0 ? [`${name} ${kind}: ${count}`] : [],
        ),
      );
      if (leaks.length > 0) {
        throw new Error(`Unsettled foreign A2A controls: ${leaks.join(", ")}`);
      }
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
