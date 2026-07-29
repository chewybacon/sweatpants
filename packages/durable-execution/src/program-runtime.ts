import { createContext, scoped, type Operation } from "effection";
import { createApi } from "effection/experimental";
import { CrankError } from "./errors.ts";
import type { DurableProgramManifest, PinnedProgram } from "./program-contract.ts";
import type {
  ProgramAttachment,
  ProgramCommand,
  ProgramDriver,
  ProgramRestoreRequest,
  ProgramRoute,
  ProgramRunRequest,
  ProgramRunResult,
  ProgramShutdownReason,
  ProgramStep,
} from "./program-driver-contract.ts";
import {
  ProgramDriverRegistryContext,
  type ProgramDriverRegistry,
} from "./program-runtime-context.ts";

/** Canonical ProgramDriver dispatch API. */
export const ProgramPeer = createApi("durable-execution:program-peer", {
  *attach(request: Parameters<ProgramDriver["attach"]>[0]): Operation<ProgramAttachment> {
    const driver = yield* driverFor(driverKind(request.route));
    return yield* driver.attach(request);
  },
  *step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep> {
    return yield* (yield* driverFor(attachment.driverKind)).step(attachment, command);
  },
  *restore(request: ProgramRestoreRequest) {
    const driver = yield* driverFor(driverKind(request.attach.route));
    if (!driver.restore) {
      throw new CrankError("program_protocol_error", "Program driver has no restore fast path");
    }
    return yield* driver.restore(request);
  },
  *shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void> {
    yield* (yield* driverFor(attachment.driverKind)).shutdown(attachment, reason);
  },
  *manifest(route: ProgramRoute, program: PinnedProgram): Operation<DurableProgramManifest> {
    const driver = yield* driverFor(driverKind(route));
    if (!driver.manifest) {
      throw new CrankError(
        "program_version_unavailable",
        `Driver ${driverKind(route)} cannot resolve program manifests`,
      );
    }
    return yield* driver.manifest(program);
  },
});

/** Deployment-owned child placement policy; authored programs remain location-neutral. */
export const ProgramRouteResolverContext = createContext<
  ((program: PinnedProgram, parentRoute: ProgramRoute) => Operation<ProgramRoute>) | undefined
>("durable-execution:program-route-resolver", undefined);

export interface ProgramRuntimeDriver {
  run(request: ProgramRunRequest): Operation<ProgramRunResult>;
}

/** Scoped implementation seam; the API identity remains durable-execution-owned. */
export const ProgramRuntimeDriverContext = createContext<ProgramRuntimeDriver | undefined>(
  "durable-execution:program-runtime-driver",
  undefined,
);

export const ProgramRuntime = createApi("durable-execution:program-runtime", {
  *run(request: ProgramRunRequest): Operation<ProgramRunResult> {
    const driver = yield* ProgramRuntimeDriverContext.get();
    if (!driver) throw new CrankError("unknown_target", "No ProgramRuntime driver is installed");
    return yield* driver.run(request);
  },
});

export function withProgramRuntimeDriver<T>(
  driver: ProgramRuntimeDriver,
  body: () => Operation<T>,
): Operation<T> {
  return scoped(() => ProgramRuntimeDriverContext.with(driver, body));
}

export const {
  attach: attachProgram,
  restore: restoreProgram,
  step: stepProgram,
  shutdown: shutdownProgram,
  manifest: resolveProgramManifest,
} = ProgramPeer.operations;
export const { run: runDurableProgram } = ProgramRuntime.operations;

function* driverFor(kind: string): Operation<ProgramDriver> {
  const registry: ProgramDriverRegistry | undefined = yield* ProgramDriverRegistryContext.get();
  const driver = registry?.get(kind);
  if (!driver) throw new CrankError("unknown_target", `No program driver for ${kind}`);
  return driver;
}

function driverKind(route: ProgramRoute): string {
  if (route === null || typeof route !== "object" || Array.isArray(route)) return "program";
  const value = route["driverKind"] ?? route["kind"];
  return typeof value === "string" && value ? value : "program";
}
