import { expect, it } from "vitest";
import { activeWork } from "../activity.ts";
import type { ReactChatUIPart } from "@sweatpants/react-chat";

it("shows resumption once a local reply is completed but the host has not settled it", () => {
  const pending: ReactChatUIPart = {
    type: "elicit",
    id: "ask",
    elicitId: "e",
    bindingId: "b",
    key: "reply",
    message: "Name?",
    state: "pending",
    parts: [
      {
        type: "render",
        id: "r",
        parentElicitId: "e",
        sequence: 0,
        state: "completed",
        node: null,
        response: { action: "accept" },
      },
    ],
  };
  expect(activeWork(pending)[0]?.label).toBe("Resuming workflow");
  expect(activeWork({ ...pending, parts: [] })[0]?.label).toBe("Waiting for input");
  expect(activeWork({ ...pending, state: "responded", localState: undefined })).toEqual([]);
});
