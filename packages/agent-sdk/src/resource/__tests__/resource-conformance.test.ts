import { run, type Operation } from "effection";
import { describe, expect, it, vi } from "vitest";

import {
  createTestDurableProgramContext,
  type TestProgramResume,
} from "@sweatpants/durable-execution/testing";
import { type Json } from "@sweatpants/foundation";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";

import {
  ResourcePackageRegistry,
  binaryResource,
  binaryResourceFromBase64,
  defineResourcePackage,
  defineResourceView,
  encodeResourceBase64,
  formatResourceUri,
  generateResourceReaders,
  jsonResource,
  listResources,
  normalizeResourcePath,
  parseResourcePackageManifest,
  parseResourceUri,
  readResource,
  resourcePackageManifestParser,
  resolveAuthorizedResource,
  searchResources,
  textResource,
  type ResourcePackage,
} from "../index.ts";

function install(pkg: ResourcePackage): ResourcePackageRegistry {
  const registry = new ResourcePackageRegistry(pkg.limits);
  registry.install(pkg);
  return registry;
}

function modelView(pkg: ResourcePackage, limits = {}) {
  return defineResourceView(
    [
      {
        root: "docs",
        package: pkg,
        access: { kind: "model_readable", classification: "internal" },
      },
    ],
    { limits },
  );
}

describe("resource identity golden vectors", () => {
  it("matches independently computed file and package SHA-256 vectors", () => {
    const pkg = defineResourcePackage({
      id: "golden",
      version: "1",
      files: { "a.txt": textResource("hello\n") },
    });
    expect(pkg.manifest.files["a.txt"]?.digest).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
    expect(pkg.manifest.digest).toBe(
      "d83a9d601b1b07b0b793ced7dd3a5da6a085f04e2367db23473387b5710c9ce2",
    );
    expect(resourcePackageManifestParser.parse(pkg.manifest)).toEqual({
      ok: true,
      value: pkg.manifest,
    });
    expect(
      resourcePackageManifestParser.parse({ ...pkg.manifest, digest: "0".repeat(64) }).ok,
    ).toBe(false);
  });

  it("round-trips generated base64 bindings exactly", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const encoded = encodeResourceBase64(bytes);
    const pkg = defineResourcePackage({
      id: "base64",
      version: "1",
      files: { "all.bin": binaryResourceFromBase64(encoded, "application/octet-stream") },
    });
    expect(pkg.bindings.read("all.bin")).toEqual(bytes);
    expect(() =>
      binaryResourceFromBase64("not canonical", "application/octet-stream"),
    ).toThrowError(expect.objectContaining({ code: "invalid_resource_manifest" }));
  });
});

describe("portable paths and limits", () => {
  it("rejects NFC and Unicode simple-case-fold collisions", () => {
    expect(() =>
      defineResourcePackage({
        id: "unicode",
        version: "1",
        files: {
          "café.txt": textResource("one"),
          "cafe\u0301.txt": textResource("two"),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_resource_path" }));

    // Cherokee small A simple-folds to Cherokee capital A.
    expect(() =>
      defineResourcePackage({
        id: "cherokee",
        version: "1",
        files: { "\u13a0.txt": textResource("one"), "\uab70.txt": textResource("two") },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_resource_path" }));
  });

  it("accepts exact boundaries and rejects boundary plus one", () => {
    expect(
      defineResourcePackage({
        id: "limits",
        version: "1",
        files: { "a.txt": binaryResource(new Uint8Array(4), "application/octet-stream") },
        limits: { maxFiles: 1, maxPathBytes: 5, maxFileBytes: 4, maxPackageBytes: 4 },
      }).manifest.files["a.txt"]?.size,
    ).toBe(4);
    expect(() =>
      defineResourcePackage({
        id: "limits",
        version: "1",
        files: {
          "a.txt": textResource("a"),
          "b.txt": textResource("b"),
        },
        limits: { maxFiles: 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "resource_limit_exceeded" }));
    expect(() =>
      normalizeResourcePath("aa.txt", { ...modelLimits(), maxPathBytes: 5 }),
    ).toThrowError(expect.objectContaining({ code: "resource_limit_exceeded" }));
    expect(() =>
      defineResourcePackage({
        id: "limits",
        version: "1",
        files: { "a.bin": binaryResource(new Uint8Array(5), "application/octet-stream") },
        limits: { maxFileBytes: 4 },
      }),
    ).toThrowError(expect.objectContaining({ code: "resource_limit_exceeded" }));
  });

  it("rejects malformed authored text and JSON before producing an artifact", () => {
    expect(() => textResource("\ud800")).toThrowError(
      expect.objectContaining({ code: "invalid_resource_manifest" }),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => jsonResource(cyclic)).toThrowError(
      expect.objectContaining({ code: "invalid_resource_manifest" }),
    );
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "not evaluated",
    });
    expect(() => jsonResource(accessor)).toThrowError(
      expect.objectContaining({ code: "invalid_resource_manifest" }),
    );
  });

  it.each([
    ["../secret", "invalid_resource_path"],
    ["/absolute", "invalid_resource_path"],
    ["a\\b", "invalid_resource_path"],
    ["a//b", "invalid_resource_path"],
  ])("maps malformed path %s to %s", (path, code) => {
    expect(() => normalizeResourcePath(path)).toThrowError(expect.objectContaining({ code }));
  });
});

describe("reader search safety and schemas", () => {
  it("bounds scans through readResource and reports first-match-per-file", () => {
    const pkg = defineResourcePackage({
      id: "search",
      version: "1",
      files: {
        "a.txt": textResource("needle first needle second"),
        "b.txt": textResource("Needle in B"),
        "c.txt": textResource("needle in C"),
      },
    });
    const registry = install(pkg);
    const view = modelView(pkg, { maxSearchMatches: 2, maxReadBytes: 64 });
    const result = searchResources(view, registry, { kind: "model" }, "  NEEDLE ") as Record<
      string,
      Json
    >;
    expect(result["matchSemantics"]).toBe("first-match-per-file");
    expect(result["truncated"]).toBe(true);
    expect(result["matches"]).toMatchObject([
      { path: "docs/a.txt", excerpt: expect.stringContaining("needle first") },
      { path: "docs/b.txt", excerpt: expect.stringContaining("Needle in B") },
    ]);
  });

  it("bounds aggregate no-match scan work independently of package size", () => {
    const pkg = defineResourcePackage({
      id: "scan-budget",
      version: "1",
      files: {
        "a.txt": textResource("aaaaa"),
        "b.txt": textResource("bbbbb"),
        "c.txt": textResource("ccccc"),
      },
    });
    const result = searchResources(
      modelView(pkg, { maxReadBytes: 5, maxSearchMatches: 1 }),
      install(pkg),
      { kind: "model" },
      "needle",
    ) as Record<string, Json>;
    expect(result).toMatchObject({ matches: [], truncated: true });
  });

  it("fails before decoding a text file above maxReadBytes", () => {
    const pkg = defineResourcePackage({
      id: "oversized-search",
      version: "1",
      files: { "large.txt": textResource("needle and more") },
    });
    expect(() =>
      searchResources(
        modelView(pkg, { maxReadBytes: 4 }),
        install(pkg),
        { kind: "model" },
        "needle",
      ),
    ).toThrowError(expect.objectContaining({ code: "resource_read_too_large" }));
  });

  it("returns typed failures for missing and corrupt bindings at use", () => {
    const pkg = defineResourcePackage({
      id: "binding-check",
      version: "1",
      files: { "a.txt": textResource("needle") },
    });
    const view = modelView(pkg);
    const missingPackage = {
      ...pkg,
      bindings: { ...pkg.bindings, read: () => undefined },
    };
    const corruptPackage = {
      ...pkg,
      bindings: { ...pkg.bindings, read: () => new TextEncoder().encode("changed") },
    };
    // SAFETY: these boundary fakes deliberately expose only the operation under
    // test; searchResources depends solely on ResourcePackageRegistry.resolve.
    const missingRegistry = { resolve: () => missingPackage } as unknown as ResourcePackageRegistry;
    // SAFETY: same one-method boundary fake as above.
    const corruptRegistry = { resolve: () => corruptPackage } as unknown as ResourcePackageRegistry;
    expect(() => searchResources(view, missingRegistry, { kind: "model" }, "needle")).toThrowError(
      expect.objectContaining({ code: "resource_not_found" }),
    );
    expect(() => searchResources(view, corruptRegistry, { kind: "model" }, "needle")).toThrowError(
      expect.objectContaining({ code: "resource_digest_mismatch" }),
    );
  });

  it("pins concrete closed reader schemas and validates produced output", async () => {
    const pkg = defineResourcePackage({
      id: "schemas",
      version: "1",
      files: { "a.txt": textResource("hello") },
    });
    const readers = generateResourceReaders({
      view: modelView(pkg),
      registry: install(pkg),
      consumer: { kind: "model" },
    });
    expect(readers.read.manifest.inputSchema.digest).not.toBe(ANY_JSON_SCHEMA_DESCRIPTOR.digest);
    expect(readers.read.manifest.outputSchema.digest).not.toBe(ANY_JSON_SCHEMA_DESCRIPTOR.digest);
    expect(readers.read.schemaCatalog).toHaveLength(2);
    const ref = { packageId: pkg.manifest.id, packageDigest: pkg.manifest.digest, path: "a.txt" };
    const output = await run(() => readers.read.program({ ref }, {} as never));
    const validInput = await readers.read.schemaCatalog[0]!.schema["~standard"].validate({ ref });
    expect(validInput.issues).toBeUndefined();
    const invalidInput = await readers.read.schemaCatalog[0]!.schema["~standard"].validate({
      ref,
      undeclared: true,
    });
    expect(invalidInput.issues).toBeDefined();
    const valid = await readers.read.schemaCatalog[1]!.schema["~standard"].validate(output);
    expect(valid.issues).toBeUndefined();
    const invalid = await readers.read.schemaCatalog[1]!.schema["~standard"].validate({
      ...(output as Record<string, Json>),
      undeclared: true,
    });
    expect(invalid.issues).toBeDefined();
  });

  it("paginates lists stably and changes reader identity with output bounds", () => {
    const pkg = defineResourcePackage({
      id: "pagination",
      version: "1",
      files: {
        "a.txt": textResource("a"),
        "b.txt": textResource("b"),
        "c.txt": textResource("c"),
      },
    });
    const registry = install(pkg);
    const firstView = modelView(pkg, { maxListEntries: 2 });
    const first = listResources(firstView, registry, { kind: "model" });
    expect(first).toMatchObject({
      truncated: true,
      cursor: "docs/b.txt",
      entries: [{ logicalPath: "docs/a.txt" }, { logicalPath: "docs/b.txt" }],
    });
    expect(
      listResources(firstView, registry, { kind: "model" }, { cursor: first.cursor! }).entries.map(
        (entry) => entry.logicalPath,
      ),
    ).toEqual(["docs/c.txt"]);
    const firstReaders = generateResourceReaders({
      view: firstView,
      registry,
      consumer: { kind: "model" },
    });
    const secondReaders = generateResourceReaders({
      view: modelView(pkg, { maxListEntries: 3 }),
      registry,
      consumer: { kind: "model" },
    });
    expect(firstReaders.list.manifest.digest).not.toBe(secondReaders.list.manifest.digest);
  });

  it("keeps equivalent mount declaration order out of view and reader identity", () => {
    const first = defineResourcePackage({
      id: "order-a",
      version: "1",
      files: { "a.txt": textResource("a") },
    });
    const second = defineResourcePackage({
      id: "order-b",
      version: "1",
      files: { "b.txt": textResource("b") },
    });
    const mounts = [
      {
        root: "a",
        package: first,
        access: { kind: "model_readable" as const, classification: "public" as const },
      },
      {
        root: "b",
        package: second,
        access: { kind: "model_readable" as const, classification: "internal" as const },
      },
    ];
    expect(defineResourceView(mounts).digest).toBe(
      defineResourceView([mounts[1]!, mounts[0]!]).digest,
    );
  });

  it("executes an effect-free generated reader through its authored program", async () => {
    const pkg = defineResourcePackage({
      id: "driver-reader",
      version: "1",
      files: { "a.txt": textResource("hello") },
    });
    const readers = generateResourceReaders({
      view: modelView(pkg),
      registry: install(pkg),
      consumer: { kind: "model" },
    });
    const input = {
      ref: { packageId: pkg.manifest.id, packageDigest: pkg.manifest.digest, path: "a.txt" },
    };
    const result = await run(() =>
      readers.read.program(
        input,
        createTestDurableProgramContext(() =>
          (function* (): Operation<TestProgramResume> {
            throw new Error("resource reader proposed unexpected durable work");
          })(),
        ),
      ),
    );
    expect(result).toMatchObject({ kind: "text", text: "hello" });
  });

  it("does not search program-private content or include it in counts", () => {
    const visible = defineResourcePackage({
      id: "visible-search",
      version: "1",
      files: { "visible.txt": textResource("needle visible") },
    });
    const hidden = defineResourcePackage({
      id: "hidden-search",
      version: "1",
      files: { "private-sentinel.txt": textResource("needle PRIVATE-SENTINEL") },
    });
    const registry = new ResourcePackageRegistry();
    registry.install(visible);
    registry.install(hidden);
    const view = defineResourceView([
      {
        root: "visible",
        package: visible,
        access: { kind: "model_readable", classification: "public" },
      },
      { root: "hidden", package: hidden, access: { kind: "program_private" } },
    ]);
    const encoded = JSON.stringify(searchResources(view, registry, { kind: "model" }, "needle"));
    expect(encoded).toContain("visible/visible.txt");
    expect(encoded).not.toContain("PRIVATE-SENTINEL");
    expect(encoded).not.toContain("private-sentinel.txt");
  });
});

describe("hidden lookup and content-safe errors", () => {
  it("collapses denied and missing lookups at an explicit external boundary", () => {
    const pkg = defineResourcePackage({
      id: "private",
      version: "1",
      files: { "secret.txt": textResource("sentinel-secret") },
    });
    const registry = install(pkg);
    const view = defineResourceView([
      { root: "private", package: pkg, access: { kind: "program_private" } },
    ]);
    const denied = {
      packageId: pkg.manifest.id,
      packageDigest: pkg.manifest.digest,
      path: "secret.txt",
    };
    const missing = { packageId: "missing", packageDigest: "f".repeat(64), path: "secret.txt" };
    expect(() =>
      resolveAuthorizedResource(view, registry, denied, { kind: "model" }, { hideExistence: true }),
    ).toThrowError(
      expect.objectContaining({ code: "resource_not_found", message: "Resource unavailable" }),
    );
    expect(() =>
      resolveAuthorizedResource(
        view,
        registry,
        missing,
        { kind: "model" },
        { hideExistence: true },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "resource_not_found", message: "Resource unavailable" }),
    );
  });

  it("pins hidden-boundary behavior into generated reader identity and failures", () => {
    const pkg = defineResourcePackage({
      id: "hidden-reader",
      version: "1",
      files: { "secret.txt": textResource("secret") },
    });
    const registry = install(pkg);
    const view = defineResourceView([
      { root: "private", package: pkg, access: { kind: "program_private" } },
    ]);
    const internal = generateResourceReaders({ view, registry, consumer: { kind: "model" } });
    const hidden = generateResourceReaders({
      view,
      registry,
      consumer: { kind: "model" },
      hideExistence: true,
    });
    expect(hidden.read.manifest.digest).not.toBe(internal.read.manifest.digest);
    const hiddenRead = hidden.read.program(
      {
        ref: {
          packageId: pkg.manifest.id,
          packageDigest: pkg.manifest.digest,
          path: "secret.txt",
        },
      },
      {} as never,
    );
    expect(() => hiddenRead[Symbol.iterator]().next()).toThrowError(
      expect.objectContaining({ code: "resource_not_found" }),
    );
  });

  it("does not place content or host path sentinels in safe failures or console output", () => {
    const sentinel = "credential-token-SHOULD-NOT-LEAK";
    const hostPath = "/private/checkout/SHOULD-NOT-LEAK";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pkg = defineResourcePackage({
      id: "redaction",
      version: "1",
      files: { "secret.txt": textResource(sentinel) },
    });
    let message = "";
    try {
      readResource(
        modelView(pkg),
        install(pkg),
        { kind: "model" },
        { packageId: pkg.manifest.id, packageDigest: pkg.manifest.digest, path: hostPath },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain(hostPath);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("stable error-code matrix", () => {
  it("maps canonical negative conditions to their assigned safe codes", () => {
    const text = defineResourcePackage({
      id: "error-text",
      version: "1",
      files: { "a.txt": textResource("too large") },
    });
    const binary = defineResourcePackage({
      id: "error-binary",
      version: "1",
      files: { "a.bin": binaryResource(new Uint8Array([1]), "application/octet-stream") },
    });
    const textRegistry = install(text);
    const privateView = defineResourceView([
      { root: "private", package: text, access: { kind: "program_private" } },
    ]);
    const textRef = {
      packageId: text.manifest.id,
      packageDigest: text.manifest.digest,
      path: "a.txt",
    };
    const cases: Array<[string, () => unknown]> = [
      ["invalid_resource_manifest", () => parseResourcePackageManifest({})],
      ["invalid_resource_path", () => normalizeResourcePath("../x")],
      [
        "resource_limit_exceeded",
        () =>
          defineResourcePackage({
            id: "limited",
            version: "1",
            files: { "a.txt": textResource("xx") },
            limits: { maxFileBytes: 1 },
          }),
      ],
      [
        "resource_digest_mismatch",
        () => parseResourcePackageManifest({ ...text.manifest, digest: "0".repeat(64) }),
      ],
      [
        "resource_identity_mismatch",
        () => textRegistry.resolve(text.manifest.digest, { version: "wrong" }),
      ],
      ["resource_not_found", () => textRegistry.resolve("f".repeat(64))],
      [
        "resource_access_denied",
        () => resolveAuthorizedResource(privateView, textRegistry, textRef, { kind: "model" }),
      ],
      [
        "resource_mount_conflict",
        () =>
          defineResourceView([
            { root: "same", package: text, access: { kind: "program_private" } },
            { root: "same/nested", package: text, access: { kind: "program_private" } },
          ]),
      ],
      [
        "resource_read_too_large",
        () =>
          readResource(
            modelView(text, { maxReadBytes: 1 }),
            textRegistry,
            { kind: "model" },
            textRef,
          ),
      ],
      [
        "unsupported_resource_projection",
        () =>
          readResource(
            modelView(binary),
            install(binary),
            { kind: "model" },
            {
              packageId: binary.manifest.id,
              packageDigest: binary.manifest.digest,
              path: "a.bin",
            },
          ),
      ],
    ];
    for (const [expectedCode, trigger] of cases) {
      expect(trigger).toThrowError(expect.objectContaining({ code: expectedCode }));
    }
  });
});

describe("manifest and URI negative conformance", () => {
  it("rejects unknown manifest fields and noncanonical resource URIs", () => {
    const pkg = defineResourcePackage({
      id: "closed",
      version: "1",
      files: { "é.txt": textResource("x") },
    });
    expect(() => parseResourcePackageManifest({ ...pkg.manifest, unknown: true })).toThrowError(
      expect.objectContaining({ code: "invalid_resource_manifest" }),
    );
    const uri = formatResourceUri({
      packageId: pkg.manifest.id,
      packageDigest: pkg.manifest.digest,
      path: "é.txt",
    });
    expect(uri).toContain("%C3%A9.txt");
    expect(() => parseResourceUri(uri.replace("%C3%A9", "%c3%a9"))).toThrowError(
      expect.objectContaining({ code: "invalid_resource_path" }),
    );
  });
});

function modelLimits() {
  return {
    maxFiles: 4096,
    maxPathBytes: 512,
    maxFileBytes: 16 * 1024 * 1024,
    maxPackageBytes: 64 * 1024 * 1024,
    maxReadBytes: 256 * 1024,
    maxListEntries: 1024,
    maxSearchMatches: 256,
  };
}
