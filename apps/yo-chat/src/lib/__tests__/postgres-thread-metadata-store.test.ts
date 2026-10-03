// @vitest-environment node
import { expect, it } from "vitest";
import { createPostgresThreadMetadataStore } from "../postgres-thread-metadata-store";
import { configureThreadMetadataStore } from "../thread-metadata-store";
import { handleThreadMetadataRequest } from "../thread-metadata-api";

it("persists metadata across pool restart and supports the asynchronous HTTP store", async () => {
  const connectionString =
    process.env["SWEATPANTS_DATABASE_URL"] ??
    "postgres://postgres:postgres@127.0.0.1:55432/sweatpants_test";
  const namespace = `metadata-test-${crypto.randomUUID()}`;
  const id = `${namespace}:one`;
  const first = createPostgresThreadMetadataStore(connectionString);
  try {
    await first.create({ id, namespace, title: "  Flight planning  ", messageCount: 1 });
    await first.update(id, { lastMessagePreview: "  Seat 5A  ", messageCount: 3 });
  } finally {
    await first.close?.();
  }
  const restarted = createPostgresThreadMetadataStore(connectionString);
  try {
    configureThreadMetadataStore(restarted);
    const response = await handleThreadMetadataRequest(
      new Request(`http://localhost/api/threaded-chat/threads?namespace=${namespace}`),
    );
    expect(response.status).toBe(200);
    const { threads } = await response.json();
    expect(threads).toEqual([
      expect.objectContaining({
        id,
        namespace,
        title: "Flight planning",
        lastMessagePreview: "Seat 5A",
        messageCount: 3,
        createdAt: expect.any(Number),
      }),
    ]);
    await Promise.all([
      restarted.update(id, { title: "Renamed" }),
      restarted.update(id, { messageCount: 4 }),
    ]);
    expect(await restarted.get(id)).toMatchObject({ title: "Renamed", messageCount: 4 });
    const deleted = await handleThreadMetadataRequest(
      new Request(`http://localhost/api/threaded-chat/threads/${id}`, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(204);
    expect(await restarted.get(id)).toBeNull();
  } finally {
    await restarted.delete(id);
    await restarted.close?.();
    await restarted.close?.();
  }
});
