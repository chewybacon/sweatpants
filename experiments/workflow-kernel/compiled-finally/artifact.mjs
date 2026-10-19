import { compileWorkflow } from "../compiled-frames/compiler.mjs";
import { compile } from "./engine.mjs";
import { hash, copy, ENGINE_ID, COMPLETION_POLICY } from "./journal.mjs";
import { schemas as defaultSchemas, textV1 } from "./schemas.mjs";
const check = (ok, message) => {
    if (!ok) {
        throw Error(message);
    }
};
export function artifact(source, contracts, schemas = defaultSchemas, boundary) {
    const compiled = compileWorkflow(source, {
        compileScheme: compile,
        allowFinally: true,
        allowEnsure: true,
        allowScopes: true,
        entryInput: !!boundary,
    });
    const sites = compiled.program.functions.flatMap((f) =>
        f.code.filter((i) => i[0] === "yield").map((i) => i[1]),
    );
    check(
        sites.every((s) => typeof s === "string") && new Set(sites).size === sites.length,
        "Invalid effect sites",
    );
    const fallback = { reply: textV1.descriptor.digest, error: textV1.descriptor.digest };
    contracts = contracts ?? Object.fromEntries(sites.map((site) => [site, fallback]));
    check(
        Object.keys(contracts).length === sites.length && sites.every((site) => contracts[site]),
        "Effect contract coverage mismatch",
    );
    const schemaDescriptors = {};
    for (const contract of Object.values(contracts)) {
        check(
            Object.keys(contract).length === 2 &&
                typeof contract.reply === "string" &&
                typeof contract.error === "string",
            "Invalid effect contract",
        );
        for (const digest of Object.values(contract)) {
            const entry = schemas.get(digest);
            check(entry, "Missing schema validator");
            schemaDescriptors[digest] = entry.descriptor;
        }
    }
    if (boundary) {
        for (const digest of Object.values(boundary)) {
            const entry = schemas.get(digest);
            check(entry, "Missing boundary schema validator");
            schemaDescriptors[digest] = entry.descriptor;
        }
    }
    const body = {
        /* CONDITIONAL-SPREAD: Snapshot JSON has no boundary field until the evaluator reaches a boundary. */
        ...(boundary ? { boundary } : {}),
        format: 2,
        completionPolicy: COMPLETION_POLICY,
        engine: ENGINE_ID,
        compiled,
        contracts: copy(contracts),
        schemaDescriptors,
    };
    return { ...body, id: hash(body) };
}
