import type {
  DecisionStageDiagnostic,
  DurableAuthoritySnapshot,
  SemanticEmissionPolicy,
} from "../contract/authority-contract.ts";
import type { CapabilityKeyring } from "../contract/capabilities.ts";
import type { DurableSchemaRegistry } from "../contract/schema-registry.ts";

export type {
  DecisionStageDiagnostic,
  DecisionStageName,
  DurableAuthoritySnapshot,
  SemanticEmissionPolicy,
} from "../contract/authority-contract.ts";

export interface InMemoryJournalAuthorityOptions {
  journalId: string;
  journalIncarnation?: string;
  keyring: CapabilityKeyring;
  now?: () => number;
  maxOutcomeBytes?: number;
  emissionPolicy?: SemanticEmissionPolicy;
  snapshot?: DurableAuthoritySnapshot;
  schemaRegistry?: DurableSchemaRegistry;
  decisionDiagnostics?: (diagnostic: DecisionStageDiagnostic) => void;
  /** Internal shell seam: defer process-local wakeups until after state commit. */
  deferCancellationSignals?: boolean;
}
