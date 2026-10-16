import { documentEffect, implementEffect } from "@sweatpants/agent-sdk";
import { JournalAuthorityPort } from "@sweatpants/journal-authority";

export const documentEffectRegistration = implementEffect(
  documentEffect,
  function* (input, context) {
    return yield* JournalAuthorityPort.api.operations.command({
      type: "document.operate",
      request: {
        sessionId: context.sessionId,
        taskId: context.taskId,
        pullId: context.pullId,
        attemptId: context.attemptId,
        input,
      },
    });
  },
);
