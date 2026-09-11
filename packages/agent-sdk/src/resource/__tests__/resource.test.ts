import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "effection";
import { afterEach, describe, expect, it } from "vitest";

import {
  ResourcePackageRegistry,
  binaryResource,
  combineResourceProvenance,
  compileResourceDirectory,
  defineGuidance,
  defineResourcePackage,
  defineResourceView,
  formatResourceUri,
  generateResourceReaders,
  guidanceIndex,
  jsonResource,
  listResources,
  parseResourcePackageManifest,
  parseResourceUri,
  readResource,
  resolveGuidanceLink,
  statResource,
  textResource,
  watchResourceDirectory,
  type ResourceError,
} from "../index.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixture() {
  const source = new Uint8Array([0, 1, 2, 255]);
  const pkg = defineResourcePackage({
    id: "reviewing-designs",
    version: "1",
    files: {
      "SKILL.md": textResource("\ufeff# Skill\r\n[ref](references/check.md)\r"),
      "references/check.md": textResource("check\n"),
      "data.json": jsonResource({ z: 1, a: true }),
      "raw.bin": binaryResource(source, "application/octet-stream"),
    },
  });
  source[0] = 99;
  return pkg;
}

describe("resource packages", () => {
  it("normalizes text/JSON, preserves binary, and snapshots caller data", () => {
    const pkg = fixture();
    expect(new TextDecoder().decode(pkg.bindings.read("SKILL.md"))).toBe(
      "# Skill\n[ref](references/check.md)\n",
    );
    expect(new TextDecoder().decode(pkg.bindings.read("data.json"))).toBe('{"a":true,"z":1}');
    const bytes = pkg.bindings.read("raw.bin")!;
    expect([...bytes]).toEqual([0, 1, 2, 255]);
    bytes[0] = 100;
    expect(pkg.bindings.read("raw.bin")![0]).toBe(0);
    expect(Object.isFrozen(pkg.manifest)).toBe(true);
    expect(parseResourcePackageManifest(pkg.manifest)).toEqual(pkg.manifest);
  });

  it("is insertion-order independent and rejects portable path collisions", () => {
    const left = defineResourcePackage({
      id: "pkg",
      version: "1",
      files: { "b.txt": textResource("b"), "a.txt": textResource("a") },
    });
    const right = defineResourcePackage({
      id: "pkg",
      version: "1",
      files: { "a.txt": textResource("a"), "b.txt": textResource("b") },
    });
    expect(left.manifest.digest).toBe(right.manifest.digest);
    expect(() =>
      defineResourcePackage({
        id: "pkg",
        version: "1",
        files: { "A.txt": textResource("a"), "a.txt": textResource("b") },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_resource_path" }));
    expect(() =>
      defineResourcePackage({ id: "pkg", version: "1", files: { "../x": textResource("x") } }),
    ).toThrowError(expect.objectContaining({ code: "invalid_resource_path" }));
  });

  it("atomically installs complete exact packages", () => {
    const pkg = fixture();
    const registry = new ResourcePackageRegistry();
    registry.install(pkg);
    const installed = registry.resolve(pkg.manifest.digest, { id: pkg.manifest.id });
    expect(installed.manifest).toEqual(pkg.manifest);
    expect(installed.bindings.read("raw.bin")).toEqual(pkg.bindings.read("raw.bin"));
    expect(() => registry.resolve(pkg.manifest.digest, { version: "wrong" })).toThrowError(
      expect.objectContaining({ code: "resource_identity_mismatch" }),
    );
    const corrupt = {
      ...pkg,
      bindings: { ...pkg.bindings, read: () => new Uint8Array([1]) },
    };
    expect(() => registry.install(corrupt)).toThrowError(
      expect.objectContaining({ code: "resource_digest_mismatch" }),
    );
  });
});

describe("views, guidance, and readers", () => {
  it("enforces exact mount scopes and deterministic reader behavior", async () => {
    const pkg = fixture();
    const registry = new ResourcePackageRegistry();
    registry.install(pkg);
    const view = defineResourceView([
      {
        root: "docs",
        package: pkg,
        access: { kind: "model_readable", classification: "internal" },
      },
    ]);
    const ref = {
      packageId: pkg.manifest.id,
      packageDigest: pkg.manifest.digest,
      path: "SKILL.md",
    };
    expect(statResource(view, registry, { kind: "model" }, ref).classifications).toEqual([
      "internal",
    ]);
    expect(readResource(view, registry, { kind: "model" }, ref)).toMatchObject({
      kind: "text",
      classifications: ["internal"],
    });
    const listed = listResources(view, registry, { kind: "model" });
    expect(listed.entries.map((entry) => entry.logicalPath)).toEqual([
      "docs/SKILL.md",
      "docs/data.json",
      "docs/raw.bin",
      "docs/references/check.md",
    ]);
    const readers = generateResourceReaders({ view, registry, consumer: { kind: "model" } });
    expect(readers.read.manifest.effects).toEqual({});
    expect(readers.read.identityProvenance.kind).toBe("generated-artifact");
    const outcome = await run(() => readers.read.program({ ref }, {} as never));
    expect(outcome).toMatchObject({ kind: "text", text: expect.stringContaining("Skill") });
    expect(() =>
      readResource(view, registry, { kind: "model" }, { ...ref, path: "raw.bin" }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_resource_projection" }));
  });

  it("rejects mount overlap and wrong exact tool identities", () => {
    const pkg = fixture();
    const tool = { id: "reader", version: "1", digest: "a".repeat(64) };
    expect(() =>
      defineResourceView([
        { root: "docs", package: pkg, access: { kind: "program_private" } },
        { root: "docs/more", package: pkg, access: { kind: "program_private" } },
      ]),
    ).toThrowError(expect.objectContaining({ code: "resource_mount_conflict" }));
    const registry = new ResourcePackageRegistry();
    registry.install(pkg);
    const view = defineResourceView([
      { root: "docs", package: pkg, access: { kind: "tool_scoped", tools: [tool] } },
    ]);
    const ref = {
      packageId: pkg.manifest.id,
      packageDigest: pkg.manifest.digest,
      path: "SKILL.md",
    };
    expect(() =>
      readResource(
        view,
        registry,
        {
          kind: "tool",
          program: { ...tool, digest: "b".repeat(64) },
        },
        ref,
      ),
    ).toThrowError(expect.objectContaining({ code: "resource_access_denied" }));
    expect(readResource(view, registry, { kind: "tool", program: tool }, ref)).toMatchObject({
      kind: "text",
    });
  });

  it("keeps guidance index minimal and resolves exact relative links", () => {
    const pkg = fixture();
    const registry = new ResourcePackageRegistry();
    registry.install(pkg);
    const view = defineResourceView([
      { root: "docs", package: pkg, access: { kind: "model_readable", classification: "public" } },
    ]);
    const guidance = defineGuidance({
      id: "review",
      summary: "Review designs",
      package: pkg,
      entryPath: "SKILL.md",
    });
    expect(guidanceIndex([guidance])).toEqual([
      { id: "review", summary: "Review designs", entryUri: guidance.entryUri },
    ]);
    expect(JSON.stringify(guidanceIndex([guidance]))).not.toContain("references/check.md");
    expect(
      resolveGuidanceLink(guidance, "references/check.md", view, registry, { kind: "model" }).ref
        .path,
    ).toBe("references/check.md");
    const uri = formatResourceUri({
      packageId: pkg.manifest.id,
      packageDigest: pkg.manifest.digest,
      path: "references/check.md",
    });
    expect(parseResourceUri(uri).path).toBe("references/check.md");
    expect(() =>
      resolveGuidanceLink(guidance, "references//check.md", view, registry, { kind: "model" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_resource_path" }));
  });

  it("combines only exact payload provenance", () => {
    expect(
      combineResourceProvenance([
        {
          classifications: ["restricted"],
          sources: [{ packageDigest: "a".repeat(64), fileDigest: "b".repeat(64) }],
        },
        {
          classifications: ["public"],
          sources: [{ packageDigest: "a".repeat(64), fileDigest: "b".repeat(64) }],
        },
      ]),
    ).toEqual({
      classifications: ["public", "restricted"],
      sources: [{ packageDigest: "a".repeat(64), fileDigest: "b".repeat(64) }],
    });
  });
});

describe("directory compiler", () => {
  it("generates deterministic artifacts and verifies staleness", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-"));
    temporary.push(root);
    await mkdir(join(root, "references"));
    await writeFile(join(root, "SKILL.md"), "# Skill\r\n");
    await writeFile(join(root, "references", "a.txt"), "a\r");
    const outputFile = join(root, "generated", "resources.ts");
    const first = await compileResourceDirectory({
      root,
      id: "compiled",
      version: "1",
      ignore: ["generated/**"],
      mode: "write",
      outputFile,
    });
    await expect(
      compileResourceDirectory({
        root,
        id: "compiled",
        version: "1",
        ignore: ["generated/**"],
        mode: "verify",
        outputFile,
      }),
    ).resolves.toMatchObject({ package: { manifest: { digest: first.package.manifest.digest } } });
    expect(await readFile(outputFile, "utf8")).not.toContain(root);
    await writeFile(join(root, "references", "a.txt"), "changed");
    await expect(
      compileResourceDirectory({
        root,
        id: "compiled",
        version: "1",
        ignore: ["generated/**"],
        mode: "verify",
        outputFile,
      }),
    ).rejects.toMatchObject({
      code: "stale_generated_resource_package",
    } satisfies Partial<ResourceError>);
  });

  it("canonicalizes overlapping default JSON/text patterns and emits compact base64", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-json-"));
    temporary.push(root);
    await writeFile(join(root, "data.json"), '{"z":1,"a":true}\n');
    await writeFile(join(root, "raw.bin"), Uint8Array.from([0, 1, 2, 255]));
    const compiled = await compileResourceDirectory({ root, id: "json-default", version: "1" });
    expect(new TextDecoder().decode(compiled.package.bindings.read("data.json"))).toBe(
      '{"a":true,"z":1}',
    );
    expect(compiled.generatedSource).toContain("binaryResourceFromBase64");
    expect(compiled.generatedSource).not.toContain("Uint8Array.from([");

    const relocated = await mkdtemp(join(tmpdir(), "sweatpants-resource-json-relocated-"));
    temporary.push(relocated);
    await writeFile(join(relocated, "data.json"), '{"a":true,"z":1}\n');
    await writeFile(join(relocated, "raw.bin"), Uint8Array.from([0, 1, 2, 255]));
    const second = await compileResourceDirectory({
      root: relocated,
      id: "json-default",
      version: "1",
    });
    expect(second.generatedSource).toBe(compiled.generatedSource);
  });

  it("rejects included symlinks and hostile compiler patterns", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-symlink-"));
    temporary.push(root);
    await writeFile(join(root, "target.txt"), "target");
    await symlink(join(root, "target.txt"), join(root, "linked.txt"));
    await expect(
      compileResourceDirectory({ root, id: "symlink", version: "1" }),
    ).rejects.toMatchObject({ code: "invalid_resource_path" });
    await expect(
      compileResourceDirectory({
        root,
        id: "patterns",
        version: "1",
        include: ["**\\*.txt"],
      }),
    ).rejects.toMatchObject({ code: "invalid_resource_manifest" });
  });

  it("watch mode rebuilds with the canonical compiler and emits one digest change", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-watch-"));
    temporary.push(root);
    await writeFile(join(root, "a.txt"), "before");
    const outputFile = join(root, "generated", "resources.ts");
    let notifications = 0;
    let resolveChange!: (digest: string) => void;
    const changed = new Promise<string>((resolve) => {
      resolveChange = resolve;
    });
    let resolveCallback!: () => void;
    const callbackRelease = new Promise<void>((resolve) => {
      resolveCallback = resolve;
    });
    const watcher = await watchResourceDirectory(
      {
        root,
        id: "watched",
        version: "1",
        ignore: ["generated/**"],
        outputFile,
      },
      async (result) => {
        notifications += 1;
        resolveChange(result.package.manifest.digest);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await callbackRelease;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writeFile(join(root, "a.txt"), "after");
      const digest = await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watch notification timed out")), 3000),
        ),
      ]);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      const closing = watcher.close();
      resolveCallback();
      await closing;
      expect(notifications).toBe(1);
    } finally {
      resolveCallback();
      await watcher.close();
    }
  });

  it("stops safely when onChange awaits before stopping", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-watch-close-"));
    temporary.push(root);
    await writeFile(join(root, "a.txt"), "before");
    const outputFile = join(root, "generated", "resources.ts");
    let watcher!: Awaited<ReturnType<typeof watchResourceDirectory>>;
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    watcher = await watchResourceDirectory(
      {
        root,
        id: "watched-close",
        version: "1",
        ignore: ["generated/**"],
        outputFile,
      },
      async () => {
        resolveChange();
        await Promise.resolve();
        watcher.stop();
        resolveStopped();
      },
    );

    await writeFile(join(root, "a.txt"), "after");
    await Promise.race([
      changed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("watch close notification timed out")), 3000),
      ),
    ]);
    await stopped;
    await watcher.close();
  });

  it("externally initiated close waits for a pending onChange", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-watch-external-close-"));
    temporary.push(root);
    await writeFile(join(root, "a.txt"), "before");
    const outputFile = join(root, "generated", "resources.ts");
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    let resolveCallback!: () => void;
    const callbackRelease = new Promise<void>((resolve) => {
      resolveCallback = resolve;
    });
    const watcher = await watchResourceDirectory(
      {
        root,
        id: "watched-external-close",
        version: "1",
        ignore: ["generated/**"],
        outputFile,
      },
      async () => {
        resolveChange();
        await callbackRelease;
      },
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writeFile(join(root, "a.txt"), "after");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watch external close timed out")), 3000),
        ),
      ]);
      let settled = false;
      const closing = watcher.close().then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(settled).toBe(false);
      resolveCallback();
      await closing;
      expect(settled).toBe(true);
    } finally {
      resolveCallback();
      await watcher.close();
    }
  });

  it("observes an included source beside the generated output", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-watch-sibling-"));
    temporary.push(root);
    const outputDirectory = join(root, "generated");
    await mkdir(outputDirectory);
    const source = join(outputDirectory, "source.txt");
    await writeFile(source, "before");
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = await watchResourceDirectory(
      {
        root,
        id: "watched-sibling",
        version: "1",
        include: ["generated/source.txt"],
        outputFile: join(outputDirectory, "resources.ts"),
      },
      () => {
        resolveChange();
      },
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writeFile(source, "after");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watch sibling notification timed out")), 3000),
        ),
      ]);
    } finally {
      await watcher.close();
    }
  });

  it("surfaces rebuild failures through close", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweatpants-resource-watch-error-"));
    temporary.push(root);
    await writeFile(join(root, "a.txt"), "before");
    const outputFile = join(root, "generated", "resources.ts");
    const failure = new Error("consumer rejected the resource update");
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = await watchResourceDirectory(
      {
        root,
        id: "watched-error",
        version: "1",
        ignore: ["generated/**"],
        outputFile,
      },
      () => {
        resolveChange();
        throw failure;
      },
    );

    await writeFile(join(root, "a.txt"), "after");
    await Promise.race([
      changed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("watch error notification timed out")), 3000),
      ),
    ]);
    await expect(watcher.close()).rejects.toBe(failure);
  });
});
