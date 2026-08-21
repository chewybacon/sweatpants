import type {
  DecisionStageDiagnostic,
  DurableAuthoritySnapshot,
  SemanticEmissionPolicy,
} from "./authority-contract.ts";
import type { CapabilityKeyring } from "./capabilities.ts";
import type { DurableSchemaRegistry } from "./schema-registry.ts";

export type {
  DecisionStageDiagnostic,
  DecisionStageName,
  DurableAuthoritySnapshot,
  SemanticEmissionPolicy,
} from "./authority-contract.ts";

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
