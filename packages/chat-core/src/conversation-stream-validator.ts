import { EventType, type AGUIEvent } from "@ag-ui/core";
import {
  isConversationAuthorityFrame,
  type ConversationStreamEvent,
} from "./conversation-protocol.ts";
import { isConversationWindowFrame } from "./conversation-window.ts";

export class ChatSegmentOrderError extends Error {
  readonly code: "chat_segment_order_invalid" | "chat_authority_missing";

  constructor(code: "chat_segment_order_invalid" | "chat_authority_missing", message: string) {
    super(message);
    this.name = "ChatSegmentOrderError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new ChatSegmentOrderError("chat_segment_order_invalid", message);
}

function authorityMissing(message: string): never {
  throw new ChatSegmentOrderError("chat_authority_missing", message);
}

function terminalOutcome(event: AGUIEvent): { readonly type?: unknown } | null | undefined {
  return event.type === EventType.RUN_FINISHED ? event.outcome : undefined;
}

/**
 * Stateful production validator for one finite native Chat response.
 * Call `finish()` when the transport reaches EOF.
 */
export class ConversationSegmentValidator {
  private eventCount = 0;
  private runStarted = false;
  private initialAuthority = false;
  private pendingWindow = false;
  private sawWindow = false;
  private sawGenericSnapshot = false;
  private terminalAuthorityState: "idle" | "parked" | "deleted" | null = null;
  private terminal = false;
  private hydrationAuthority = false;
  private rejectionAuthority = false;

  push(event: ConversationStreamEvent): void {
    if (this.terminal) {
      invalid("no value may follow a terminal AG-UI event");
    }

    if (isConversationWindowFrame(event)) {
      this.pushWindow();
      this.eventCount += 1;
      return;
    }
    if (isConversationAuthorityFrame(event)) {
      this.pushAuthority(event.authority.state);
      this.eventCount += 1;
      return;
    }

    this.pushAGUI(event);
    this.eventCount += 1;
  }

  finish(): void {
    if (this.terminal) {
      return;
    }
    if (this.hydrationAuthority && this.sawWindow && !this.runStarted && !this.pendingWindow) {
      return;
    }
    if (this.runStarted && !this.initialAuthority) {
      authorityMissing("response ended before running authority completed the initial prelude");
    }
    if (this.pendingWindow) {
      authorityMissing("response ended before authority completed a window replacement");
    }
    invalid("response ended without a valid hydration or terminal response state");
  }

  private pushWindow(): void {
    if (this.terminalAuthorityState !== null) {
      invalid("window replacement cannot follow terminal authority");
    }
    if (this.sawGenericSnapshot) {
      invalid("native ConversationWindow cannot coexist with generic AG-UI snapshots");
    }
    if (!this.runStarted) {
      if (this.eventCount !== 0 || this.sawWindow) {
        invalid("hydration window must be the first response value");
      }
      this.sawWindow = true;
      this.pendingWindow = true;
      return;
    }
    if (!this.initialAuthority) {
      if (this.sawWindow || this.pendingWindow) {
        invalid("initial run prelude contains more than one window");
      }
      this.sawWindow = true;
      this.pendingWindow = true;
      return;
    }
    if (this.pendingWindow) {
      invalid("window replacement requires an immediately following authority frame");
    }
    this.sawWindow = true;
    this.pendingWindow = true;
  }

  private pushAuthority(state: "idle" | "running" | "parked" | "recovering" | "deleted"): void {
    if (!this.runStarted) {
      if (this.pendingWindow) {
        if (!(state === "idle" || state === "parked" || state === "deleted")) {
          invalid("hydration window requires idle, parked, or deleted authority");
        }
        this.pendingWindow = false;
        this.hydrationAuthority = true;
        return;
      }
      if (this.eventCount !== 0) {
        invalid("rejection authority must precede the first AG-UI event");
      }
      this.rejectionAuthority = true;
      return;
    }

    if (!this.initialAuthority) {
      if (this.sawWindow && !this.pendingWindow) {
        invalid("initial window already has authority");
      }
      if (!this.sawWindow && !this.sawGenericSnapshot) {
        authorityMissing("initial running authority requires window or snapshot synchronization");
      }
      if (state !== "running") {
        invalid("initial admitted-run authority must be running");
      }
      this.pendingWindow = false;
      this.initialAuthority = true;
      return;
    }

    if (this.pendingWindow) {
      this.pendingWindow = false;
      if (state === "running") {
        return;
      }
      if (state === "idle" || state === "parked" || state === "deleted") {
        this.terminalAuthorityState = state;
        return;
      }
      invalid("window replacement authority has an invalid state");
    }

    if (state === "idle" || state === "parked" || state === "deleted") {
      if (this.terminalAuthorityState !== null) {
        invalid("a finite response segment may contain only one terminal authority");
      }
      this.terminalAuthorityState = state;
      return;
    }
    invalid("running/recovering authority requires a preceding window replacement");
  }

  private pushAGUI(event: AGUIEvent): void {
    const type = event.type;
    if (!this.runStarted) {
      if (type === EventType.RUN_STARTED) {
        if (this.eventCount !== 0) {
          invalid("RUN_STARTED must be the first response value for an admitted run");
        }
        this.runStarted = true;
        return;
      }
      if (type === EventType.RUN_ERROR) {
        if (this.sawWindow || this.hydrationAuthority) {
          invalid("hydration cannot emit RUN_ERROR");
        }
        // A pre-admission rejection may include one current authority control.
        if (this.eventCount > 1 || (this.eventCount === 1 && !this.rejectionAuthority)) {
          invalid("RUN_ERROR is not a valid first-and-final rejection event");
        }
        this.terminal = true;
        return;
      }
      invalid(`${type} cannot appear before RUN_STARTED`);
    }

    if (!this.initialAuthority) {
      if (
        type === EventType.MESSAGES_SNAPSHOT ||
        type === EventType.ACTIVITY_SNAPSHOT ||
        type === EventType.STATE_SNAPSHOT
      ) {
        if (this.sawWindow) {
          invalid("native window prelude cannot also carry generic AG-UI snapshots");
        }
        this.sawGenericSnapshot = true;
        return;
      }
      authorityMissing(`${type} arrived before running authority completed the initial prelude`);
    }

    if (this.pendingWindow) {
      authorityMissing(`${type} arrived before authority completed a window replacement`);
    }
    if (type === EventType.RUN_STARTED) {
      invalid("a finite response segment may contain only one RUN_STARTED");
    }
    if (type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR) {
      if (this.terminalAuthorityState === null) {
        authorityMissing("terminal AG-UI event requires committed idle or parked authority first");
      }
      const outcome = terminalOutcome(event);
      if (
        this.terminalAuthorityState === "parked" &&
        (type !== EventType.RUN_FINISHED || outcome?.type !== "interrupt")
      ) {
        invalid("parked authority requires interrupt-aware RUN_FINISHED");
      }
      if (
        this.terminalAuthorityState !== "parked" &&
        type === EventType.RUN_FINISHED &&
        outcome?.type === "interrupt"
      ) {
        invalid("interrupt-aware RUN_FINISHED requires parked authority");
      }
      this.terminal = true;
      return;
    }
    if (this.terminalAuthorityState !== null) {
      invalid("incremental AG-UI event cannot follow terminal authority");
    }
    if (
      this.sawWindow &&
      (type === EventType.MESSAGES_SNAPSHOT || type === EventType.STATE_SNAPSHOT)
    ) {
      invalid("native ConversationWindow cannot coexist with generic message/state snapshots");
    }
  }
}

export function validateConversationSegment(events: readonly ConversationStreamEvent[]): void {
  const validator = new ConversationSegmentValidator();
  for (const event of events) {
    validator.push(event);
  }
  validator.finish();
}
