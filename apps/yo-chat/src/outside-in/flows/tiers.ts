/**
 * Tier selection + live-gating for outside-in flow tests (design R7/R11/G4).
 *
 * - Tier A runs by default for live flows (fast in-process worker loop).
 * - Tier B runs only when `OUTSIDE_IN_TIER_B=1` (boots/reuses the real server).
 * - Live flows are gated behind `RUN_LIVE=1`, so unmarked/manual runs stay
 *   hermetic and avoid importing app/tool runtime modules that could touch the
 *   network or print noisy setup logs.
 * - When `RUN_LIVE=1`, tests RUN and `requireCopilotAuth()` fails fast if auth
 *   is missing/expired. Integration coverage should fail, not silently skip.
 */
import type { ChatBinding } from "../lib/chat-fetch.ts";

export interface TierCase {
  name: string;
  create: () => Promise<ChatBinding>;
}

export const LIVE_ENABLED = process.env["RUN_LIVE"] === "1";

/** True when live integration was explicitly requested. */
export function liveReady(): boolean {
  return LIVE_ENABLED;
}

export function selectedTiers(): TierCase[] {
  const cases: TierCase[] = [
    {
      name: "tier-a",
      create: async () => {
        const { createTierABinding } = await import("../lib/tier-a.ts");
        return createTierABinding();
      },
    },
  ];

  if (process.env["OUTSIDE_IN_TIER_B"] === "1") {
    cases.push({
      name: "tier-b",
      create: async () => {
        const { createTierBBinding } = await import("../lib/tier-b.ts");
        return createTierBBinding();
      },
    });
  }
  return cases;
}
