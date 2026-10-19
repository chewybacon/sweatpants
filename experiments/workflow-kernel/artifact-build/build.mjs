import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { compileToolDefinition } from "../tool-contracts/compiler.mjs";
import { hash } from "../compiled-finally/journal.mjs";
import { createDurableSchemaRegistry } from "../compiled-finally/schemas.mjs";
import { encodeSchema } from "./validators.mjs";
import { runtimeId, loadBundle } from "./load.mjs";
export function buildBundle(source) {
    const { artifact: compiledArtifact, schemas, tool } = compileToolDefinition(source),
        builtins = createDurableSchemaRegistry([]),
        validators = {};
    const schemaDescriptors = { ...compiledArtifact.schemaDescriptors };
    for (const entry of tool.artifacts.catalog) {
        schemaDescriptors[entry.descriptor.digest] = entry.descriptor;
    }
    for (const digest of Object.keys(schemaDescriptors)) {
        const entry = schemas.get(digest);
        validators[digest] = builtins.get(digest)
            ? { builtin: digest }
            : encodeSchema(entry.schema);
    }
    const runtime = runtimeId();
    const { id: oldId, ...compiledBody } = compiledArtifact;
    const { digest: interfaceDigest, ...manifest } = tool.manifest;
    const artifactBody = {
        ...compiledBody,
        schemaDescriptors,
        manifest,
        bundleContract: hash({ runtime, validators }),
    };
    const artifact = { ...artifactBody, id: hash(artifactBody) };
    const body = { format: 1, runtime, artifact, validators, source };
    const bundle = { ...body, id: hash(body) };
    loadBundle(bundle);
    return bundle;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [, , sourcePath, outputPath] = process.argv;
    if (!sourcePath || !outputPath) {
        throw Error("Usage: node build.mjs source.ts bundle.json");
    }
    const bundle = buildBundle(fs.readFileSync(sourcePath, "utf8"));
    const temporary = outputPath + "." + process.pid + ".tmp";
    let created = false;
    try {
        fs.writeFileSync(temporary, JSON.stringify(bundle, null, 2) + "\n", { flag: "wx" });
        created = true;
        fs.renameSync(temporary, outputPath);
    } finally {
        if (created && fs.existsSync(temporary)) {
            fs.unlinkSync(temporary);
        }
    }
    console.log(
        JSON.stringify({ bundle: bundle.id, artifact: bundle.artifact.id, output: outputPath }),
    );
}
