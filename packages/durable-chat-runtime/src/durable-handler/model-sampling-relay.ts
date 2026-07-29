import type { Operation } from "effection";
import type { TokenBuffer, TokenBufferWriter } from "@sweatpants/durable-streams";
import type {
  ProgramDeliveryEnvelope,
  ProgramDeliveryWriter,
} from "@sweatpants/durable-effects/model-sample";

/** Adapts the current root TokenBuffer fence to the narrow sampling delivery capability. */
export function createProgramDeliveryWriter(
  writer: TokenBufferWriter<ProgramDeliveryEnvelope>,
): ProgramDeliveryWriter {
  return Object.freeze({
    *append(events: readonly ProgramDeliveryEnvelope[]): Operation<number> {
      return yield* writer.append([...events]);
    },
  });
}

/**
 * Derives relay progress from authoritative retained root envelopes. Auxiliary
 * cursor indexes may use this operation to verify or repair their value.
 */
export function* highestRemoteOriginLsn(
  buffer: TokenBuffer<ProgramDeliveryEnvelope>,
  streamId: string,
): Operation<number> {
  const { tokens } = yield* buffer.read(0);
  let highest = 0;
  for (const envelope of tokens) {
    if (
      envelope.origin?.kind === "agentcore-model-sample" &&
      envelope.origin.streamId === streamId
    ) {
      highest = Math.max(highest, envelope.origin.lsn);
    }
  }
  return highest;
}

/** Public protocol projections expose only the placement-neutral event. */
export function projectProgramDeliveryEnvelope(
  envelope: ProgramDeliveryEnvelope,
): ProgramDeliveryEnvelope["event"] {
  return envelope.event;
}
