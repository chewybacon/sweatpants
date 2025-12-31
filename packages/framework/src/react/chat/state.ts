/**
 * react/chat/state.ts
 *
 * Backwards-compatible re-export from lib/chat/state.
 *
 * @deprecated Import from '@tanstack/framework/lib/chat/state' instead
 */

export { chatReducer, initialChatState } from '../../lib/chat/state'
export type { ChatState, ToolEmissionState, ToolEmissionTrackingState, PendingClientToolState } from '../../lib/chat/state'
export type { PendingHandoffState } from '../../lib/chat/patches'
