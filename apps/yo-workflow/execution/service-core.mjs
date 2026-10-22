import { createWorkflowBindingResolver } from "@sweatpants/flowmode-backend";
import { requireCompiledWorkflow } from "@sweatpants/flowmode-runtime";
import { callerContract } from "./contracts.mts";
import {
  createJournal,
  createMemoryExecutionStore,
  createCapabilityKeyring,
  driveProgramDriverActivation,
} from "@sweatpants/journal-authority";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR as schema,
  ProgramDriverRegistryContext,
} from "@sweatpants/durable-execution";
import {
  defineDurableEffect,
  createDurableEffectRegistration,
} from "@sweatpants/durable-effects/authoring";
import {
  DurableEffectRegistryContext,
  createDurableEffectRegistry,
  DurableEffects,
  ProgramPlacementContext,
} from "@sweatpants/durable-effects";
const sendDefinition = defineDurableEffect({
  name: "send_announcement",
  version: "1",
  inputSchema: schema,
  outputSchema: schema,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});
import { run, call } from "effection";
const randomUUID = () => crypto.randomUUID();

export function executionServiceFactory(stacks) {
  const languages = stacks.map((stack) => stack.descriptor);
  function select(language) {
    const stack = stacks.find((candidate) => candidate.descriptor.id === language);
    if (!stack) {
      throw Error(`Unavailable workflow language: ${language}`);
    }
    return stack;
  }
  async function validateCaller(source, language = "scheme") {
    if (typeof source !== "string" || source.length > 12000) {
      return "Expected workflow source of at most 12000 characters";
    }
    try {
      return await run(function* () {
        const program = yield* buildProgram(source, language);
        const kernel = yield* program.createKernel();
        try {
          // Preflight runs through the same kernel seam without dispatching effects.
          const { boundary } = yield* kernel.start(program.artifact, confirmationInput);
          if (
            boundary.kind !== "suspended" ||
            boundary.request.binding !== JSON.stringify(["elicit", "approval"])
          ) {
            return "The caller must first request approval through review_draft(input)";
          }
          return "";
        } finally {
          yield* kernel.close();
        }
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  const confirmationInput = {
    title: "Review the launch announcement",
    recipient: "Sam",
    metadata: null,
  };
  function* prepareBindings(stack) {
    const reviewDraft = yield* stack.definition();
    const bindings = [
      {
        kind: "compiled",
        contract: reviewDraft.exports[0].contract,
        module: reviewDraft,
        export: "reviewDraft",
      },
      {
        kind: "host",
        contract: {
          id: JSON.stringify(["effect", sendDefinition.name, sendDefinition.version]),
          name: sendDefinition.name,
          description: "Queue an announcement",
          inputSchema: sendDefinition.inputSchema,
          outputSchema: sendDefinition.outputSchema,
        },
        capability: { name: sendDefinition.name, version: sendDefinition.version },
      },
      ...reviewDraft.imports.map((d) => ({ ...d, capability: { name: "elicit", version: "1" } })),
    ];
    return { reviewDraft, bindings };
  }
  function* linkCaller(callerSource, stack) {
    const { linker, compiler } = stack;
    const { reviewDraft, bindings } = yield* prepareBindings(stack);
    const caller = requireCompiledWorkflow(
      yield* compiler.compile({
        source: { id: "caller", language: compiler.sourceLanguage, text: callerSource },
        entry: "workflow",
        exports: [{ name: "workflow", entry: "workflow", contract: callerContract }],
        bindings: bindings.map(({ kind, contract }) => ({ kind, contract })),
      }),
    );
    const linked = yield* linker.link({ caller, bindings });
    return { linked, reviewDraft, bindings };
  }

  function* buildProgram(callerSource, language) {
    const stack = select(language);
    const {
      linked: implementation,
      reviewDraft,
      bindings,
    } = yield* linkCaller(callerSource, stack);
    const program = stack.createProgram({
      implementation,
      bindings,
      contract: {
        programId: "inspect-confirmation",
        version: "1",
        inputSchema: schema,
        outputSchema: schema,
        effects: { send_announcement: sendDefinition },
        elicits: { approval: { response: schema }, cleanup: { response: schema } },
        capabilities: {
          durableEmissions: false,
          structuredChildren: false,
          replay: "strict",
        },
      },
      bindOperation: createWorkflowBindingResolver(bindings, [
        {
          name: sendDefinition.name,
          version: sendDefinition.version,
          describe({ input }) {
            return {
              kind: "effect",
              name: sendDefinition.name,
              version: sendDefinition.version,
              input,
              resolver: { audience: "host:announcements" },
            };
          },
        },
        {
          name: "elicit",
          version: "1",
          describe({ input, site }, contract) {
            if (typeof input?.message !== "string") {
              throw Error("Expected elicitation message");
            }
            return {
              kind: "elicit",
              key: contract.name,
              message: input.message,
              response: schema,
              binding: { id: site },
            };
          },
        },
      ]),
    });
    return {
      ...program,
      developerSource: reviewDraft.source.text,
      compiledSites: reviewDraft.debug.sites,
    };
  }

  // Local playground composition over production journal/driver APIs. No test transport
  // or model simulator: the developer fixture is run directly and the UI supplies replies.
  /** @param {{
   * author?: (prompt: string, language: string) => Promise<string>,
   * persistence?: {
   *   load(id: string): Promise<Record<string, unknown> | undefined>,
   *   save(id: string, value: Record<string, unknown>): Promise<void>
   * },
   * storeFactory?: typeof createMemoryExecutionStore,
   * secret?: string
   * }} [options] */
  function createExecutionService({
    author,
    persistence,
    storeFactory = createMemoryExecutionStore,
    secret = randomUUID().repeat(2),
  } = {}) {
    const sessions = new Map();
    const keyring = createCapabilityKeyring("execution-playground", [{ keyId: "local", secret }]);
    async function saveSession(session) {
      if (!persistence) {
        return;
      }
      const { program, store, busy, outbox, ...state } = session;
      await persistence.save(session.id, {
        ...state,
        programDigest: program.artifact.digest,
        outbox: [...outbox],
      });
    }
    async function loadSession(id) {
      if (sessions.has(id)) {
        return sessions.get(id);
      }
      const saved = await persistence?.load(id);
      if (!saved) {
        return undefined;
      }
      const program = await run(() => buildProgram(saved.authored, saved.language));
      if (saved.programDigest !== program.artifact.digest) {
        throw Error(
          "workflow_source_changed: This run uses a different compiled workflow. Start a new run.",
        );
      }
      const session = {
        ...saved,
        program,
        store: storeFactory(),
        outbox: new Map(saved.outbox),
        busy: false,
      };
      sessions.set(id, session);
      return session;
    }
    function trace(session, kind, data = {}) {
      session.trace.push({
        sequence: session.nextEvent++,
        at: new Date().toISOString(),
        kind,
        ...data,
      });
      if (session.trace.length > 100) {
        session.trace.shift();
      }
    }
    function observe(session, kind, data) {
      if (data?.inspection) {
        session.inspection = data.inspection;
      }
      trace(session, `kernel.${kind}`, {
        /* CONDITIONAL-SPREAD: Omit absent durationMs from workflow requests and execution events; explicit undefined is not a portable JSON value. */
        ...(data?.durationMs === undefined ? {} : { durationMs: data.durationMs }),
        /* CONDITIONAL-SPREAD: Only present boundary/snapshot/reply data may override the preceding event data. */
        ...(data?.boundary ? { data: data.boundary } : {}),
        /* CONDITIONAL-SPREAD: Only present boundary/snapshot/reply data may override the preceding event data. */
        ...(data?.snapshot ? { data: data.snapshot } : {}),
        /* CONDITIONAL-SPREAD: Only present boundary/snapshot/reply data may override the preceding event data. */
        ...(data?.reply ? { data: data.reply } : {}),
      });
    }
    function view(session) {
      return structuredClone({
        id: session.id,
        revision: session.revision,
        status: session.result?.state ?? "idle",
        result: session.result ?? null,
        inspection: session.inspection ?? null,
        checkpoint: session.checkpoint ?? null,
        restoration: session.restoration ?? null,
        pending: session.pending ?? null,
        trace: session.trace,
        outbox: [...session.outbox.values()],
        language: select(session.language).descriptor,
        developerSource: session.program.developerSource,
        programSource: session.program.artifact.code,
        compiledSites: session.program.compiledSites,
      });
    }
    return {
      languages,
      get(id) {
        if (sessions.has(id)) {
          return view(sessions.get(id));
        }
        return loadSession(id).then((session) => {
          if (!session) {
            throw Error("Execution not found. Local runs expire when the dev server restarts.");
          }
          return view(session);
        });
      },
      async command(command) {
        let session;
        if (command.action === "start") {
          if (sessions.size >= 32) {
            throw Error("Local execution limit reached. Restart the dev server to clear runs.");
          }
          const language = command.language ?? "scheme";
          const stack = select(language);
          const authored = command.prompt ? await author?.(command.prompt, language) : stack.caller;
          if (typeof authored !== "string" || !authored.trim()) {
            throw Error("Model authoring is unavailable or returned no source");
          }
          const program = await run(() => buildProgram(authored, language));
          session = {
            program,
            authored,
            language,
            outbox: new Map(),
            id: command.id ?? randomUUID(),
            store: storeFactory(),
            revision: 0,
            trace: [],
            nextEvent: 0,
            busy: false,
          };
          sessions.set(session.id, session);
          await saveSession(session);
        } else {
          session = await loadSession(command.id);
          if (!session) {
            throw Error("Execution not found");
          }
          if (command.revision !== session.revision) {
            throw Error("Execution changed. Reload before continuing.");
          }
        }
        const program = session.program;
        if (session.busy) {
          throw Error("Execution is busy");
        }
        session.busy = true;
        try {
          await run(function* () {
            const journal = yield* createJournal(session.store, {
              journalId: session.id,
              keyring,
            });
            const attach = {
              sessionId: session.id,
              taskId: "root",
              executionEpoch: 1,
              program: {
                id: program.manifest.programId,
                version: "1",
                digest: program.manifest.digest,
              },
              input: confirmationInput,
              route: { driverKind: session.language },
            };
            const driver = program.createDriver((kind, data) => observe(session, kind, data));
            yield* ProgramDriverRegistryContext.with(
              new Map([[session.language, driver]]),
              function* () {
                if (command.action === "start") {
                  yield* journal.advance({
                    type: "execution.open-task",
                    request: {
                      ...attach,
                      turnId: "turn",
                      manifest: program.manifest,
                      attachmentId: "unattached",
                      audience: "local-inspector",
                    },
                  });
                  trace(session, "host.start", { data: attach.input });
                } else {
                  if (session.result?.state !== "parked") {
                    throw Error("Execution is not waiting");
                  }
                  if (command.action === "restore") {
                    const saved = yield* journal.exportSnapshot();
                    const task = saved.sessions
                      .find(([id]) => id === session.id)?.[1]
                      .execution.tasks.find((task) => task.taskId === attach.taskId);
                    const checkpoint = task?.execution.checkpoint;
                    if (checkpoint?.kind !== "continuation") {
                      throw Error("No accepted checkpoint is available");
                    }
                    trace(session, "host.restore-requested");
                    const kernel = yield* program.createKernel((kind, data) =>
                      observe(session, kind, data),
                    );
                    try {
                      const before = session.inspection.steps;
                      const restored = yield* kernel.restore(
                        program.artifact,
                        checkpoint.state.backend,
                      );
                      if (session.inspection.steps !== before) {
                        throw Error("Restoration changed the evaluator step count");
                      }
                      const recaptured = yield* restored.execution.capture();
                      if (
                        JSON.stringify(recaptured.state) !==
                        JSON.stringify(checkpoint.state.backend.state)
                      ) {
                        throw Error("Restoration changed checkpoint state");
                      }
                      session.restoration = {
                        stateUnchanged: true,
                        stepsBefore: before,
                        stepsAfter: session.inspection.steps,
                      };
                      trace(session, "host.restore-verified", {
                        data: {
                          boundary: restored.boundary,
                          stepsBefore: before,
                          stepsAfter: session.inspection.steps,
                        },
                      });
                    } finally {
                      yield* kernel.close();
                    }
                    return;
                  }
                  if (command.action === "cancel") {
                    yield* journal.advance({
                      type: "execution.request-cancellation",
                      request: {
                        sessionId: session.id,
                        taskId: attach.taskId,
                        reason: "Cancelled in inspector",
                        commandId: randomUUID(),
                      },
                    });
                    trace(session, "authority.cancellation-accepted");
                  } else if (command.action === "reply") {
                    if (
                      session.pending.key === "approval" &&
                      !["approve", "decline"].includes(command.choice)
                    ) {
                      throw Error("Choose approve or decline");
                    }
                    if (session.pending.key === "cleanup" && command.choice !== "release") {
                      throw Error("Choose release");
                    }
                    const value = {
                      action: "accept",
                      content: { approved: command.choice === "approve" },
                    };
                    const capability = yield* journal.query({
                      type: "pull.resolution-capability",
                      sessionId: session.id,
                      taskId: attach.taskId,
                      pullId: session.result.pullId,
                    });
                    const accepted = yield* journal.advance({
                      type: "execution.resolve-pull",
                      request: {
                        capability,
                        audience: `user:${session.pending.key}`,
                        outcome: { status: "ok", value },
                      },
                    });
                    if (accepted.status === "rejected") {
                      throw Error(
                        `Reply rejected by journal authority: ${JSON.stringify(accepted)}`,
                      );
                    }
                    trace(session, "authority.reply-accepted", { data: value });
                  } else {
                    throw Error("Unknown execution command");
                  }
                }
                session.result = yield* driveProgramDriverActivation({
                  authority: {
                    command: journal.advance.bind(journal),
                    query: journal.query.bind(journal),
                  },
                  driver,
                  attach,
                  advancement: {
                    effects: {
                      *route() {
                        return "host";
                      },
                      *executeHost(authorization, placement) {
                        const registry = createDurableEffectRegistry([
                          createDurableEffectRegistration(
                            sendDefinition,
                            sendDefinition.retrySafety,
                            function* (input, ctx) {
                              if (
                                !input ||
                                typeof input !== "object" ||
                                typeof input.title !== "string" ||
                                typeof input.recipient !== "string"
                              ) {
                                return {
                                  status: "error",
                                  error: {
                                    code: "invalid_announcement",
                                    message: "Expected title and recipient strings",
                                  },
                                };
                              }
                              let item = session.outbox.get(ctx.pullId);
                              if (!item) {
                                item = {
                                  announcementId: randomUUID(),
                                  status: "queued",
                                  title: input.title,
                                  recipient: input.recipient,
                                };
                                session.outbox.set(ctx.pullId, item);
                                yield* call(() => saveSession(session));
                                trace(session, "host.announcement-queued", { data: item });
                              }
                              return { status: "ok", value: item };
                            },
                          ),
                        ]);
                        return yield* DurableEffectRegistryContext.with(registry, function* () {
                          return yield* ProgramPlacementContext.with(placement, function* () {
                            return yield* DurableEffects.operations.execute(authorization);
                          });
                        });
                      },
                    },
                  },
                });
                const saved = yield* journal.exportSnapshot();
                session.checkpoint =
                  saved.sessions
                    .find(([id]) => id === session.id)?.[1]
                    .execution.tasks.find((task) => task.taskId === attach.taskId)?.execution
                    .checkpoint ?? null;
                session.restoration = null;
                const records = yield* journal.readSession(session.id);
                const pull =
                  session.result.state === "parked"
                    ? records.find(
                        (record) =>
                          record.payload.type === "PullRequested" &&
                          record.payload.pullId === session.result.pullId,
                      )?.payload
                    : null;
                session.pending = pull
                  ? {
                      key: pull.descriptor.key,
                      message: pull.descriptor.message,
                      pullId: pull.pullId,
                    }
                  : null;
                trace(session, `host.${session.result.state}`, {
                  data: session.result,
                });
              },
            );
          });
          session.revision++;
          await saveSession(session);
          return view(session);
        } catch (error) {
          trace(session, "host.error", { data: { message: error.message } });
          session.revision++;
          await saveSession(session);
          throw error;
        } finally {
          session.busy = false;
        }
      },
    };
  }

  return {
    createExecutionService,
    validateCaller,
    languages,
    authoring: (language) =>
      run(function* () {
        const stack = select(language);
        const { bindings } = yield* prepareBindings(stack);
        const declarations = bindings.map(({ kind, contract }) => ({ kind, contract }));
        return {
          language,
          instructions: yield* stack.authoring.describe({
            bindings: declarations,
            inputSchema: callerContract.inputSchema,
            outputSchema: callerContract.outputSchema,
          }),
        };
      }),
  };
}
