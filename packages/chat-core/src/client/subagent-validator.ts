import { EventType, type AGUIEvent } from "@ag-ui/core";

/** Ownership and lifecycle validation for one AG-UI run segment. */
export class SubagentValidator {
  private readonly attributed = new Set<string>();
  private readonly announced = new Set<string>();
  private readonly active = new Set<string>();
  private readonly steps = new Set<string>();
  private readonly owners = new Map<string, string | undefined>();

  constructor(private readonly invalid: (message: string) => never) {}

  push(event: AGUIEvent): void {
    const owner = "subagentRunId" in event ? event.subagentRunId : undefined;
    if (event.type === EventType.RUN_ERROR) {
      this.active.clear();
      return;
    }
    if (event.type === EventType.RUN_FINISHED && this.active.size > 0) {
      this.invalid("RUN_FINISHED cannot leave announced subagents active");
    }
    if (event.type === EventType.SUBAGENT_STARTED) {
      if (this.attributed.has(event.subagentRunId) && !this.announced.has(event.subagentRunId)) {
        this.invalid("subagent announcement must precede attributed events");
      }
      if (this.announced.has(event.subagentRunId)) {
        this.invalid("subagent invocation announced twice");
      }
      if (event.parentSubagentRunId && !this.active.has(event.parentSubagentRunId)) {
        this.invalid("subagent parent must be active before a child is announced");
      }
      this.announced.add(event.subagentRunId);
      this.active.add(event.subagentRunId);
      return;
    }
    if (event.type === EventType.SUBAGENT_FINISHED || event.type === EventType.SUBAGENT_ERROR) {
      if (!this.active.delete(event.subagentRunId)) {
        this.invalid("subagent closed without an active announcement");
      }
      return;
    }
    if (owner && this.announced.has(owner) && !this.active.has(owner)) {
      this.invalid("event attributed to a closed subagent");
    }
    if (owner) {
      this.attributed.add(owner);
    }
    switch (event.type) {
      case EventType.STEP_STARTED: {
        const key = JSON.stringify([event.stepName, owner ?? null]);
        if (this.steps.has(key)) {
          this.invalid("step already active for this owner");
        }
        this.steps.add(key);
        break;
      }
      case EventType.STEP_FINISHED:
        if (!this.steps.delete(JSON.stringify([event.stepName, owner ?? null]))) {
          this.invalid("step finish must match its start owner");
        }
        break;
      case EventType.TEXT_MESSAGE_START:
      case EventType.REASONING_MESSAGE_START:
        this.open(`message:${event.messageId}`, owner);
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_END:
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_END:
        this.continue(`message:${event.messageId}`, owner);
        break;
      case EventType.TOOL_CALL_START: {
        const parent = event.parentMessageId ? `message:${event.parentMessageId}` : undefined;
        if (parent) {
          this.continue(parent, owner);
        }
        this.open(
          `tool:${event.toolCallId}`,
          owner ?? (parent ? this.owners.get(parent) : undefined),
        );
        break;
      }
      case EventType.TOOL_CALL_ARGS:
      case EventType.TOOL_CALL_END:
      case EventType.TOOL_CALL_RESULT:
        this.continue(`tool:${event.toolCallId}`, owner);
        break;
      case EventType.ACTIVITY_SNAPSHOT:
        this.open(`activity:${event.messageId}`, owner);
        break;
      case EventType.ACTIVITY_DELTA:
        this.continue(`activity:${event.messageId}`, owner);
        break;
      case EventType.MESSAGES_SNAPSHOT:
        for (const message of event.messages) {
          this.open(`message:${message.id}`, message.subagentRunId);
          if (message.role === "assistant") {
            for (const tool of message.toolCalls ?? []) {
              this.open(`tool:${tool.id}`, message.subagentRunId);
            }
          }
        }
        break;
    }
  }

  private open(key: string, owner: string | undefined): void {
    if (this.owners.has(key)) {
      this.continue(key, owner);
    } else {
      this.owners.set(key, owner);
    }
  }

  private continue(key: string, owner: string | undefined): void {
    // Untagged continuations inherit ownership. Attribution-only streams need no announcements.
    if (owner !== undefined && this.owners.has(key) && this.owners.get(key) !== owner) {
      this.invalid(`subagent attribution disagrees with the opener of ${key}`);
    }
  }
}
