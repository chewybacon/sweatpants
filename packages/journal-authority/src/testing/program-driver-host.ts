import { createContext, scoped, type Operation } from "effection";
import {
  CrankError,
  ProgramDriverRegistryContext,
  ProgramRouteResolver,
  programRouteDriverKind,
  type ProgramDriver,
  type ProgramRunRequest,
  type AdvancementResult,
} from "@sweatpants/durable-execution";
import {
  DurableEffectOutcomeAcknowledgerContext,
  ProgramPlacementContext,
} from "@sweatpants/durable-effects";
import {
  DurableEffectRegistryContext,
  DurableEffects,
  DurableEffectRouting,
} from "@sweatpants/durable-effects/runtime";
import { canonicalSnapshot } from "@sweatpants/foundation";

import type { JournalAuthorityContract } from "../authority-contract.ts";
import { createPullResolverRegistry, type PullResolver } from "../pull-kinds/registry.ts";
import {
  driveProgramDriverActivation,
  type JournalSamplingService,
} from "../workflow/driver-drive.ts";
import { settleParkedPull } from "../workflow/pull-settlement.ts";
import { driveWorkflowTree } from "../workflow/tree-drive.ts";

const TestJournalAuthorityContext = createContext<JournalAuthorityContract | undefined>(
  "journal-authority:test-program-driver-host",
  undefined,
);
const TestPullResolversContext = createContext<readonly PullResolver[]>(
  "journal-authority:test-pull-resolvers",
  [],
);
const TestSampleStagerContext = createContext<JournalSamplingService | undefined>(
  "journal-authority:test-sample-stager",
  undefined,
);

/** Installs only a lexical test authority; no production runtime service is installed. */
export function withProgramDriverTestScope<T>(
  authority: JournalAuthorityContract,
  body: () => Operation<T>,
): Operation<T> {
  return scoped(() => TestJournalAuthorityContext.with(authority, body));
}

/** Installs deterministic pull transports for one test activation tree. */
export function withProgramDriverTestPullResolvers<T>(
  resolvers: readonly PullResolver[],
  body: () => Operation<T>,
): Operation<T> {
  return TestPullResolversContext.with(resolvers, body);
}

/** Installs the remote-evaluator sample composition edge for a test tree. */
export function withProgramDriverTestSampleStager<T>(
  stager: JournalSamplingService,
  body: () => Operation<T>,
): Operation<T> {
  return TestSampleStagerContext.with(stager, body);
}

/** Drives through the lexical authority installed by `withProgramDriverTestScope`. */
export function* driveInstalledTestProgramTree(
  request: ProgramRunRequest,
): Operation<AdvancementResult> {
  const authority = yield* TestJournalAuthorityContext.get();
  if (!authority) {
    throw new CrankError("unknown_target", "No test journal authority is installed");
  }
  return yield* driveTestProgramTree(authority, request);
}

/**
 * Test composition over the real Authority and ProgramDriver protocols.
 * Production hosts compose the same two drive operations with deployment
 * routing and parked-pull resolvers; tests intentionally expose public parks.
 */
export function driveTestProgramTree(
  authority: JournalAuthorityContract,
  request: ProgramRunRequest,
): Operation<AdvancementResult> {
  return scoped(function* () {
    const drivers = yield* ProgramDriverRegistryContext.get();
    if (!drivers) {
      throw new CrankError("unknown_target", "No test program driver registry is installed");
    }
    const routeResolver = yield* ProgramRouteResolver.use();
    const pullResolvers = createPullResolverRegistry((yield* TestPullResolversContext.get()) ?? []);
    const stageSampleInput = yield* TestSampleStagerContext.get();

    const driverFor = (route: ProgramRunRequest["attach"]["route"]): ProgramDriver => {
      const kind = programRouteDriverKind(route);
      const driver = drivers.get(kind);
      if (!driver) {
        throw new CrankError("unknown_target", `No program driver for ${kind}`);
      }
      return driver;
    };

    return yield* driveWorkflowTree({
      authority,
      attach: request.attach,
      rootScope: {
        *activate(activation) {
          const driver = driverFor(activation.attach.route);
          return yield* driveProgramDriverActivation({
            authority,
            driver,
            attach: activation.attach,
            ...(request.activationOwnerId === undefined
              ? {}
              : { activationOwnerId: request.activationOwnerId }),
            advancement: {
              ...(stageSampleInput ? { stageSampleInput } : {}),
              effects: {
                *route({ authorization, definition }) {
                  const routed = yield* DurableEffectRouting.operations.route({
                    definition,
                    effectContractDigest: authorization.effectContractDigest,
                    sessionId: authorization.sessionId,
                    taskId: authorization.taskId,
                    pullId: authorization.pullId,
                    attemptId: authorization.attemptId,
                    program: activation.attach.program,
                    programRoute: activation.attach.route,
                  });
                  return routed.placement;
                },
                *executeHost(authorization, placement) {
                  const registry = yield* DurableEffectRegistryContext.get();
                  if (!registry) {
                    throw new CrankError(
                      "effect_placement_unavailable",
                      "No host effect registry is installed",
                    );
                  }
                  return yield* DurableEffectRegistryContext.with(registry, function* () {
                    return yield* ProgramPlacementContext.with(placement, function* () {
                      return yield* DurableEffects.operations.execute(authorization);
                    });
                  });
                },
                *acknowledge({ authorization, outcome }) {
                  const acknowledge = yield* DurableEffectOutcomeAcknowledgerContext.get();
                  if (!acknowledge) {
                    return;
                  }
                  yield* acknowledge({
                    effect: {
                      name: authorization.descriptor.name,
                      version: authorization.descriptor.version,
                    },
                    sessionId: authorization.sessionId,
                    taskId: authorization.taskId,
                    pullId: authorization.pullId,
                    attemptId: authorization.attemptId,
                    outcomeDigest: canonicalSnapshot(outcome).sha,
                  });
                },
              },
            },
          });
        },
        *manifest(program) {
          const route = yield* routeResolver.resolve({
            program,
            parentRoute: request.attach.route,
          });
          const driver = driverFor(route);
          if (!driver.manifest) {
            throw new CrankError(
              "program_version_unavailable",
              `Driver ${programRouteDriverKind(route)} cannot resolve manifests`,
            );
          }
          return yield* driver.manifest(program);
        },
        *route(program, parentRoute) {
          return yield* routeResolver.resolve({ program, parentRoute });
        },
        *settle(parked, attach) {
          const resolver = pullResolvers.get(parked.reason);
          if (!resolver) {
            return false;
          }
          yield* settleParkedPull({
            authority,
            resolver,
            attach,
            pullId: parked.pullId,
            driverKind: programRouteDriverKind(attach.route),
          });
          return true;
        },
      },
    });
  });
}
