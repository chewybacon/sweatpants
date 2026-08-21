/**
 * Outside-in HTTP test tier — shared helpers (design R12).
 *
 * One place for the fetch seam, headless driver, normalized transcript,
 * outcome assertions, auth precheck, flake policy, and the two tier bindings,
 * reused by both tiers and by future flows.
 */
export { type ChatFetch, type ChatBinding, handlerToChatFetch } from "./chat-fetch.ts";
export {
  type NormalizedEvent,
  type Transcript,
  createTranscriptCollector,
  normalizeStreamEvent,
} from "./transcript.ts";
export {
  type ElicitReply,
  type ElicitResponder,
  type ChatTurn,
  type RunChatFlowOptions,
  runChatFlow,
} from "./driver.ts";
export {
  countToolCalls,
  countElicits,
  countConfirmationTokens,
  expectToolCalled,
  expectToolCallCount,
  expectToolCallCountAtMost,
  expectElicit,
  expectElicitCount,
  expectOutcome,
  expectNoRunError,
  expectNoOpenInterruptError,
  expectNoToolRelaunchAfter,
  expectFinalTextMatches,
  expectConfirmationToken,
  expectConfirmationTokenCount,
  expectToolResultJson,
  expectTerminalTicTacToeResult,
  expectRunFinished,
} from "./assertions.ts";
export { type ModelAuthStatus, getModelAuthStatus, requireModelAuth } from "./auth.ts";
export {
  type FlakePolicy,
  DEFAULT_FLAKE_POLICY,
  AssertionFailure,
  isTransientError,
  withFlakePolicy,
} from "./flake.ts";
export { createTierABinding } from "./tier-a.ts";
export { createTierBBinding } from "./tier-b.ts";
export {
  type ServerHandle,
  type BootServerOptions,
  bootServer,
  ensureSharedServer,
  shutdownSharedServer,
} from "./server-fixture.ts";
