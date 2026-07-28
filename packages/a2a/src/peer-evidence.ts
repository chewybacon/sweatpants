import { CrankError } from "@sweatpants/durable-execution";
import { sign, verify, type KeyLike } from "node:crypto";
import { canonicalJson, sha256 } from "@sweatpants/session-contract";
import type { PeerTerminalEvidence } from "./peer-types.ts";

export function createPeerTerminalEvidence(
  input: Omit<PeerTerminalEvidence, "signature">,
  privateKey?: KeyLike,
): PeerTerminalEvidence {
  const body = canonicalEvidence(input);
  return Object.freeze({
    ...body,
    ...(privateKey
      ? { signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64") }
      : {}),
  });
}

export function verifyPeerTerminalEvidence(
  evidence: PeerTerminalEvidence,
  publicKey?: KeyLike,
): { digest: string; signed: boolean } {
  const { signature, ...input } = evidence;
  const body = canonicalEvidence(input);
  if (signature) {
    if (!publicKey) {
      throw new CrankError(
        "peer_terminal_evidence_invalid",
        "Signed evidence has no verification key",
      );
    }
    const valid = verify(
      null,
      Buffer.from(canonicalJson(body)),
      publicKey,
      Buffer.from(signature, "base64"),
    );
    if (!valid) {
      throw new CrankError("peer_terminal_evidence_invalid", "Terminal evidence signature differs");
    }
  }
  return {
    digest: sha256(
      canonicalJson({ domain: "sweatpants.peer.terminal-evidence.v1", evidence: body }),
    ),
    signed: Boolean(signature),
  };
}

function canonicalEvidence(
  input: Omit<PeerTerminalEvidence, "signature">,
): Omit<PeerTerminalEvidence, "signature"> {
  if (
    !input.taskId ||
    !/^[0-9a-f]{64}$/.test(input.calleeReleaseDigest) ||
    input.protocolVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(input.resultDigest) ||
    !/^[0-9a-f]{64}$/.test(input.grantChainHead) ||
    !/^[0-9a-f]{64}$/.test(input.delegatedEffectTranscriptHead) ||
    !/^[0-9a-f]{64}$/.test(input.calleeJournalRoot)
  ) {
    throw new CrankError("peer_terminal_evidence_invalid", "Terminal evidence fields are invalid");
  }
  return {
    taskId: input.taskId,
    calleeReleaseDigest: input.calleeReleaseDigest,
    protocolVersion: 1,
    terminalState: input.terminalState,
    resultDigest: input.resultDigest,
    grantChainHead: input.grantChainHead,
    delegatedEffectTranscriptHead: input.delegatedEffectTranscriptHead,
    calleeJournalRoot: input.calleeJournalRoot,
    ...(input.keyId ? { keyId: input.keyId } : {}),
  };
}
