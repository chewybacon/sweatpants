import type { Operation } from "effection";
import { createApi } from "effection/experimental";
import { defineResolver, type Resolver } from "@sweatpants/foundation";

import { CrankError } from "./errors.ts";
import type { DurableProgramManifest, PinnedProgram } from "./program-contract.ts";
import type {
  ProgramAttachment,
  ProgramCommand,
  ProgramDriver,
  ProgramRestoreRequest,
  ProgramRoute,
  ProgramShutdownReason,
  ProgramStep,
} from "./program-driver-contract.ts";
import {
  ProgramDriverRegistryContext,
  type ProgramDriverRegistry,
} from "./program-driver-context.ts";

/** Middleware-capable dispatch API for deployment-selected program drivers. */
export const ProgramPeer = createApi("durable-execution:program-peer", {
  *attach(request: Parameters<ProgramDriver["attach"]>[0]): Operation<ProgramAttachment> {
    const driver = yield* driverFor(driverKind(request.route));
    return yield* driver.attach(request);
  },
  *step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep> {
    const driver = yield* driverFor(attachment.driverKind);
    return yield* driver.step(attachment, command);
  },
  *restore(request: ProgramRestoreRequest) {
    const driver = yield* driverFor(driverKind(request.attach.route));
    if (!driver.restore) {
      throw new CrankError("program_protocol_error", "Program driver has no restore fast path");
    }
    return yield* driver.restore(request);
  },
  *shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void> {
    const driver = yield* driverFor(attachment.driverKind);
    yield* driver.shutdown(attachment, reason);
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

/** Input to deployment-owned child placement policy. */
export interface ProgramRouteResolutionRequest {
  readonly program: PinnedProgram;
  readonly parentRoute: ProgramRoute;
}

/** Deployment-owned child placement policy; authored programs remain location-neutral. */
export type ProgramRouteResolver = Resolver<ProgramRouteResolutionRequest, ProgramRoute>;
/** Resolver with the domain fallback of inheriting the parent route. */
export const ProgramRouteResolver = defineResolver<ProgramRouteResolutionRequest, ProgramRoute>(
  "durable-execution:program-route-resolver",
  function* ({ parentRoute }) {
    return parentRoute;
  },
);

function* driverFor(kind: string): Operation<ProgramDriver> {
  const registry: ProgramDriverRegistry | undefined = yield* ProgramDriverRegistryContext.get();
  const driver = registry?.get(kind);
  if (!driver) {
    throw new CrankError("unknown_target", `No program driver for ${kind}`);
  }
  return driver;
}

function driverKind(route: ProgramRoute): string {
  if (route === null || typeof route !== "object" || Array.isArray(route)) {
    return "program";
  }
  const value = route["driverKind"] ?? route["kind"];
  return typeof value === "string" && value ? value : "program";
}
