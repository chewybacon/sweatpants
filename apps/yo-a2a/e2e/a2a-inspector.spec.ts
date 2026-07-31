import { expect, test, type APIRequestContext } from "@playwright/test";
import { A2AInspector } from "./inspector.ts";

const cardUrl = "http://127.0.0.1:45679/.well-known/agent-card.json";
const agentToken = "inspector-bearer-secret";
const evidenceToken = "inspector-evidence-secret";
const evidenceBase = "http://127.0.0.1:45679/__sweatpants/evidence";

test.describe.serial("yo-a2a through the pinned Inspector", () => {
  test("shows bearer failure, then discovers the real authored agent", async ({ page }) => {
    const inspector = new A2AInspector(page);
    await inspector.goto();
    await inspector.connect(cardUrl);
    await inspector.expectConnectionFailure();
    await inspector.setBearer(agentToken);
    await inspector.connect(cardUrl);
    await inspector.expectConnected();
    await expect(page.locator("#agent-card-content")).toContainText("Draw and pick cards");
  });

  test("loads guidance, calls a durable tool, parks, resumes the same task, and remembers the turn", async ({
    page,
    request,
  }) => {
    const inspector = new A2AInspector(page);
    await inspector.goto();
    await inspector.setBearer(agentToken);
    await inspector.connect(cardUrl);
    await inspector.expectConnected();

    await inspector.send("draw 3 cards");
    await inspector.expectAnswer("I drew 3 cards. Pick one:");
    const contextId = await inspector.currentContext();
    const parked = await evidence(request, contextId);
    expect(parked.tasks).toHaveLength(1);
    expect(parked.tasks[0]!.state).toBe("input_required");
    const interruptedTaskId = parked.tasks[0]!.taskId;
    expectTargets(parked, {
      "chat.model.sample": 2,
      "resources.read": 1,
      pick_card: 1,
      "yo-a2a.cards.draw": 1,
      pickCard: 1,
    });

    await inspector.send("1");
    await inspector.expectAnswer("Tool completed:");
    const resumed = await evidence(request, contextId);
    expect(resumed.tasks).toHaveLength(1);
    expect(resumed.tasks[0]).toMatchObject({
      taskId: interruptedTaskId,
      state: "completed",
    });

    await inspector.showDebug();
    await expect(inspector.debug).toContainText('"taskId":');
    await expect(inspector.debug).toContainText(interruptedTaskId);
    await expect(inspector.debug).toContainText('"state": "input-required"');
    await expect(inspector.debug).toContainText('"state": "completed"');
    await expect(inspector.debug).not.toContainText(agentToken);

    await inspector.send("what card have I selected so far?");
    await inspector.expectAnswer("Conversation memory:");
    expect(await inspector.currentContext()).toBe(contextId);
    const followup = await evidence(request, contextId);
    expect(followup.tasks).toHaveLength(2);
    expect(followup.tasks[0]!.taskId).toBe(interruptedTaskId);
    expect(followup.tasks[1]!.taskId).not.toBe(interruptedTaskId);
    expect(followup.tasks.every((task) => task.state === "completed")).toBe(true);
  });

  test("renders a safe failed task", async ({ page }) => {
    const inspector = new A2AInspector(page);
    await inspector.goto();
    await inspector.setBearer(agentToken);
    await inspector.connect(cardUrl);
    await inspector.expectConnected();
    await inspector.send("FAIL_SAFE");
    await inspector.expectAnswer("Agent task failed");
    await expect(inspector.messages).not.toContainText("PRIVATE_SCRIPTED_PROVIDER_SENTINEL");
  });
});

type Evidence = {
  tasks: Array<{ taskId: string; state: string }>;
  operations: Array<{ kind: string; target: string; state: string }>;
};

async function evidence(request: APIRequestContext, contextId: string): Promise<Evidence> {
  const response = await request.get(`${evidenceBase}/${encodeURIComponent(contextId)}`, {
    headers: { authorization: `Bearer ${evidenceToken}` },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Evidence;
}
function expectTargets(evidenceValue: Evidence, expected: Record<string, number>): void {
  for (const [target, count] of Object.entries(expected)) {
    expect(
      evidenceValue.operations.filter(
        (operation) => operation.target === target || operation.target.startsWith(`${target}.`),
      ),
      target,
    ).toHaveLength(count);
  }
}
