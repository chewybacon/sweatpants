import { threadId } from "node:worker_threads";
import { suspend } from "effection";
import { workerMain } from "@effectionx/worker";

let attachment;
let generation = 0;
await workerMain(function* ({ messages }) {
    yield* messages.forEach(function* (message) {
        if (message.type === "attach") {
            if (attachment) throw new Error("concurrent attachment in one worker");
            attachment = message.request;
            generation++;
            return {
                type: "attached",
                attachment: {
                    attachmentId: `${threadId}:${generation}`,
                    taskId: attachment.taskId,
                    route: attachment.route,
                    executionEpoch: attachment.executionEpoch,
                    driverKind: "worker",
                },
            };
        }
        if (message.type === "shutdown") {
            attachment = undefined;
            return { type: "shutdown_complete" };
        }
        if (message.type === "step") {
            if (message.command.input === "crash") {
                setTimeout(() => {
                    throw new Error("injected worker death");
                }, 5);
                yield* suspend();
            }
            return { type: "step", step: { type: "completed", actionIndex: 0, value: threadId } };
        }
    });
    return { type: "closed" };
});
