import { describe, expect, it } from "vitest";
import { sha256Bytes } from "@sweatpants/foundation";
import { createInMemoryImmutableContentStore, putVerifiedContent } from "../content-store.ts";

describe("immutable A2A content custody", () => {
  it("writes and verifies bytes before returning journal reference metadata", async () => {
    const store = createInMemoryImmutableContentStore(() => 100);
    const bytes = new TextEncoder().encode("artifact");
    const reference = await putVerifiedContent(store, {
      bytes,
      mediaType: "text/plain",
      association: { kind: "artifact", id: "artifact-1" },
      retentionClass: "task",
      retainUntil: 1_000,
    });
    expect(reference).toEqual({
      digest: sha256Bytes(bytes),
      size: bytes.byteLength,
      mediaType: "text/plain",
      association: { kind: "artifact", id: "artifact-1" },
      retentionClass: "task",
    });
    expect((await store.get(reference.digest)).status).toBe("available");
  });

  it("is idempotent for exact bytes and rejects a false digest", async () => {
    const store = createInMemoryImmutableContentStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = sha256Bytes(bytes);
    await expect(store.put({ digest, bytes })).resolves.toMatchObject({ digest, size: 3 });
    await expect(store.put({ digest, bytes })).resolves.toMatchObject({ digest, size: 3 });
    await expect(store.put({ digest, bytes: new Uint8Array([4]) })).rejects.toMatchObject({
      code: "content_digest_conflict",
    });
  });

  it("distinguishes expiration, loss and collectable unreferenced objects", async () => {
    let now = 10;
    const store = createInMemoryImmutableContentStore(() => now);
    const live = new Uint8Array([1]);
    const orphan = new Uint8Array([2]);
    const liveDigest = sha256Bytes(live);
    const orphanDigest = sha256Bytes(orphan);
    await store.put({ digest: liveDigest, bytes: live, retainUntil: 50 });
    await store.put({ digest: orphanDigest, bytes: orphan, retainUntil: 20 });
    now = 25;
    await expect(store.get(orphanDigest)).resolves.toEqual({
      status: "content_expired",
      digest: orphanDigest,
      expiredAt: 20,
    });
    expect(
      await store.deleteOrphans({ referencedDigests: new Set([liveDigest]), createdBefore: 25 }),
    ).toEqual([orphanDigest]);
    await expect(store.get(orphanDigest)).resolves.toEqual({
      status: "content_unavailable",
      digest: orphanDigest,
    });
    expect((await store.get(liveDigest)).status).toBe("available");
  });
});
