# AG-UI Protocol Notes

## Current Transitional Model

The framework now emits a transitional AG-UI-aligned event family alongside the legacy chat stream events.

### AG-UI-aligned events currently emitted

- `ag_ui_run_started`
- `ag_ui_messages_snapshot`
- `ag_ui_state_snapshot`
- `ag_ui_checkpoint`
- `ag_ui_text_message_start`
- `ag_ui_text_message_content`
- `ag_ui_text_message_end`
- `ag_ui_tool_call_start`
- `ag_ui_tool_call_args`
- `ag_ui_tool_call_end`

### Transitional rules

- live UI still consumes legacy chat patches derived from legacy events
- durable replay understands AG-UI checkpoint/state events
- AG-UI state snapshot is the current home for:
  - semantic replay traces
  - pending client actions (`handoff`, `elicit`)

## Decision Summary

### Interactive replay

Use AG-UI custom state, currently represented by `ag_ui_state_snapshot.state.replay`.

### Pause / resume

Use AG-UI core tool lifecycle plus AG-UI custom state in `ag_ui_state_snapshot.state.pendingClientActions`.

### Durable restore

Use `ag_ui_checkpoint` as the AG-UI-aligned replacement seam for `conversation_state`.

## Remaining migration work

- replace the live legacy event mapper with an AG-UI-native client bridge
- define compaction rules for AG-UI snapshots and deltas
- move handoff/elicit live client transport onto AG-UI-native events
- retire legacy custom events once parity is proven
