import { createQueue, type Operation } from "effection";
import { canonicalJson, type Json } from "@sweatpants/foundation";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { PinnedProgram } from "@sweatpants/durable-execution";

/**
 * Peer protocol simulator: a scripted server behind a real client transport.
 *
 * The wire vocabulary is deliveries and acknowledgements only (REQ-040) —
 * no capability material ever serializes toward a peer. Both sides cross a
 * canonical-JSON serialization boundary so wire-shape bugs surface; the
 * server owns dedup-by-correlator (REQ-039) and programmable death
 * (REQ-043). No client method is mocked: the simulator controls responses
 * through the protocol, never by replacing implementation.
 */

export interface PeerDelivery {
  readonly correlator: string;
  readonly groupId: string;
  readonly memberTaskId: string;
  readonly program: PinnedProgram;
  readonly input: Json;
  readonly deadlineMs: number;
}

export interface PeerAck {
  readonly correlator: string;
  readonly duplicate: boolean;
}

export interface PeerEvidenceFrame {
  readonly correlator: string;
  readonly outcome: OperationOutcome;
}

export class PeerTransportError extends Error {
  readonly code = "peer_transport_unreachable";
  constructor(message: string) {
    super(message);
    this.name = "PeerTransportError";
  }
}

/** The real delivery client: serialization, retry, and evidence framing. */
export interface PeerTransport {
  /** At-least-once delivery; retries reuse the correlator (REQ-038). */
  deliver(delivery: PeerDelivery): Operation<PeerAck>;
  /** Next evidence frame from the peer; null once the server is dead. */
  nextEvidence(): Operation<PeerEvidenceFrame | null>;
}

export interface SimulatedPeerServer {
  /** Captured deliveries (decoded from the wire) in arrival order. */
  readonly deliveries: readonly PeerDelivery[];
  /** Program a terminal evidence frame the peer returns next. */
  emitEvidence(frame: PeerEvidenceFrame): void;
  /** Kill the server: deliveries stop being accepted; evidence ends. */
  kill(): void;
  readonly dead: boolean;
}

export interface PeerSimulator {
  readonly transport: PeerTransport;
  readonly server: SimulatedPeerServer;
}

/** Maximum delivery attempts before the client declares the peer lost. */
const MAX_DELIVERY_ATTEMPTS = 3;

export function createPeerSimulator(): PeerSimulator {
  const acknowledgements = new Map<string, PeerAck>();
  const captured: PeerDelivery[] = [];
  const evidenceQueue = createQueue<PeerEvidenceFrame | null, never>();
  let dead = false;

  const transport: PeerTransport = {
    *deliver(delivery) {
      // The wire: canonical JSON out, canonical JSON back.
      const encoded = canonicalJson(delivery);
      for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        if (dead) continue; // transport retry while the server is down
        const decoded = JSON.parse(encoded) as PeerDelivery;
        captured.push(decoded);
        const existing = acknowledgements.get(decoded.correlator);
        if (existing !== undefined) {
          return { ...existing, duplicate: true };
        }
        const ack: PeerAck = { correlator: decoded.correlator, duplicate: false };
        acknowledgements.set(decoded.correlator, ack);
        return ack;
      }
      throw new PeerTransportError(`Peer unreachable after ${MAX_DELIVERY_ATTEMPTS} attempts`);
    },
    *nextEvidence() {
      const next = yield* evidenceQueue.next();
      return next.done ? null : next.value;
    },
  };

  const server: SimulatedPeerServer = {
    deliveries: captured,
    get dead() {
      return dead;
    },
    emitEvidence(frame) {
      if (dead) return;
      evidenceQueue.add(frame);
    },
    kill() {
      if (dead) return;
      dead = true;
      evidenceQueue.add(null);
    },
  };

  return { transport, server };
}
