import {
  action,
  createQueue,
  resource,
  spawn,
  type Operation,
  type Queue,
  type Task,
} from "effection";
import { isExecutableToolContract, type InteractionBinding } from "@sweatpants/agent-sdk";
import {
  createToolInvocationHost,
  ToolInvocationEventSourcePort,
  ToolInvocationHostPort,
  type StartToolInvocation,
  type ToolInvocationResource,
  type ToolInvocationResourceFactory,
  type ToolSession,
} from "@sweatpants/tool-session";
import {
  parseToolParameters,
  requireToolParameterResult,
} from "@sweatpants/tool-session/tool-parameters";
import { createToolInvocationExecution } from "./tool-invocation-execution.ts";
import { createWorkerToolSession } from "./worker-tool-session.ts";

export interface LocalToolInvocationRuntimeOptions {
  readonly defaultTimeout?: number;
  readonly worker?: {
    readonly workerUrl: string | URL;
    readonly isDev?: boolean;
    readonly execArgv?: readonly string[];
  };
}

interface LocalResourceEntry {
  readonly session: ToolSession;
  readonly elicitBindings: Readonly<Record<string, InteractionBinding>>;
  readonly task: Task<void>;
}

type CreationOutcome =
  | { readonly ok: true; readonly resource: ToolInvocationResource }
  | { readonly ok: false; readonly error: unknown };

interface CreationCommand {
  readonly request: StartToolInvocation;
  readonly replies: Queue<CreationOutcome, void>;
}

function resolveWorkerUrl(workerUrl: string | URL, isDev?: boolean): string | URL {
  if (!isDev) {
    return workerUrl;
  }
  if (workerUrl instanceof URL) {
    if (workerUrl.protocol === "file:") {
      return workerUrl;
    }
    const cacheBusted = new URL(workerUrl.toString());
    cacheBusted.searchParams.set("t", Date.now().toString());
    return cacheBusted;
  }
  if (/^https?:\/\//.test(workerUrl)) {
    const cacheBusted = new URL(workerUrl);
    cacheBusted.searchParams.set("t", Date.now().toString());
    return cacheBusted;
  }
  return workerUrl;
}

export interface LocalToolInvocationResourceFactory extends ToolInvocationResourceFactory {
  activeIds(): readonly string[];
  drained(): Operation<void>;
}

/**
 * Starts one supervisor in the installation scope. Later request scopes send
 * creation commands to it; invocation tasks are its children and therefore
 * survive request teardown without retaining a foreign Scope handle.
 */
export function* createLocalToolInvocationResourceFactory(
  options: LocalToolInvocationRuntimeOptions,
): Operation<LocalToolInvocationResourceFactory> {
  return yield* resource(function* (provide) {
    const resources = new Map<string, LocalResourceEntry>();
    const drainWaiters = new Set<() => void>();
    const creationCommands = createQueue<CreationCommand, void>();

    function notifyDrained(): void {
      if (resources.size !== 0) {
        return;
      }
      for (const resolve of drainWaiters) {
        resolve();
      }
      drainWaiters.clear();
    }

    function resourceFor(entry: LocalResourceEntry): ToolInvocationResource {
      return {
        id: entry.session.id,
        toolName: entry.session.toolName,
        elicitBindings: entry.elicitBindings,
        projection: entry.session.projection,
        resume: (resume) => entry.session.resume(resume),
        *dispose() {
          resources.delete(entry.session.id);
          yield* entry.task.halt();
          notifyDrained();
        },
      };
    }

    function* startSession(request: StartToolInvocation): Operation<ToolSession> {
      const inlineTool = isExecutableToolContract(request.tool) ? request.tool : null;
      if (!options.worker && !inlineTool) {
        throw new Error(
          `Tool "${request.tool.name}" is a metadata-only contract projection; ` +
            "local inline execution requires a callable tool or worker configuration",
        );
      }

      const params = requireToolParameterResult(
        parseToolParameters({
          schema: request.tool.parameters,
          params: request.input,
          toolName: request.tool.name,
          callId: request.invocationId,
        }),
        { toolName: request.tool.name, callId: request.invocationId },
      );
      const worker = options.worker;
      if (worker) {
        return yield* createWorkerToolSession({
          sessionId: request.invocationId,
          toolName: request.tool.name,
          params,
          workerUrl: resolveWorkerUrl(worker.workerUrl, worker.isDev),
          ...(worker.execArgv && worker.execArgv.length > 0
            ? { execArgv: [...worker.execArgv] }
            : {}),
        });
      }
      return yield* createToolInvocationExecution(inlineTool!, params, {
        sessionId: request.invocationId,
        timeout: options.defaultTimeout,
      });
    }

    yield* spawn(function* invocationSupervisor() {
      while (true) {
        const nextCommand = yield* creationCommands.next();
        if (nextCommand.done) {
          return;
        }
        const command = nextCommand.value;
        const existing = resources.get(command.request.invocationId);
        if (existing) {
          command.replies.add({ ok: true, resource: resourceFor(existing) });
          continue;
        }

        const publications = createQueue<
          | { readonly ok: true; readonly session: ToolSession }
          | { readonly ok: false; readonly error: unknown },
          void
        >();
        const task = yield* spawn(function* invocationTask() {
          try {
            const session = yield* startSession(command.request);
            publications.add({ ok: true, session });
            if (session.settled) {
              yield* session.settled();
            }
          } catch (error) {
            publications.add({ ok: false, error });
          }
        });

        const publication = yield* publications.next();
        if (publication.done) {
          command.replies.add({
            ok: false,
            error: new Error("Invocation resource ended before publication"),
          });
          continue;
        }
        if (!publication.value.ok) {
          command.replies.add(publication.value);
          continue;
        }
        const entry: LocalResourceEntry = {
          session: publication.value.session,
          elicitBindings: command.request.tool.bindings.elicits,
          task,
        };
        resources.set(command.request.invocationId, entry);
        command.replies.add({ ok: true, resource: resourceFor(entry) });
      }
    });

    yield* provide({
      *create(request) {
        const replies = createQueue<CreationOutcome, void>();
        creationCommands.add({ request, replies });
        const outcome = yield* replies.next();
        if (outcome.done) {
          throw new Error("Invocation supervisor ended before replying");
        }
        if (!outcome.value.ok) {
          throw outcome.value.error;
        }
        return outcome.value.resource;
      },

      *open(invocationId) {
        const entry = resources.get(invocationId);
        return entry ? resourceFor(entry) : null;
      },

      activeIds() {
        return [...resources.keys()];
      },

      *drained() {
        if (resources.size === 0) {
          return;
        }
        yield* action<void>((resolve) => {
          drainWaiters.add(resolve);
          return () => drainWaiters.delete(resolve);
        });
      },
    });
  });
}

export interface LocalToolInvocationRuntime {
  activeIds(): readonly string[];
  drained(): Operation<void>;
}

export function* createLocalToolInvocationRuntime(
  options: LocalToolInvocationRuntimeOptions,
): Operation<LocalToolInvocationRuntime> {
  const factory = yield* createLocalToolInvocationResourceFactory(options);
  yield* ToolInvocationHostPort.installDriver(createToolInvocationHost(factory));
  yield* ToolInvocationEventSourcePort.installDriver({
    *open(invocationId) {
      const resource = yield* factory.open(invocationId);
      return resource?.projection ?? null;
    },
  });
  return {
    activeIds: () => factory.activeIds(),
    drained: () => factory.drained(),
  };
}
