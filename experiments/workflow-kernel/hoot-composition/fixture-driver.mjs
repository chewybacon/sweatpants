import { createHootProgram } from "./driver.mjs";
import { source } from "./fixture.mjs";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "../../../packages/durable-execution/dist/index.js";
const fixtureContract = {
    programId: "hoot-composition",
    version: "1",
    inputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    outputSchema: ANY_JSON_SCHEMA_DESCRIPTOR,
    effects: {},
    elicits: Object.fromEntries(
        ["reserve", "approve", "release"].map((key) => [
            key,
            { response: ANY_JSON_SCHEMA_DESCRIPTOR },
        ]),
    ),
    capabilities: { durableEmissions: true, structuredChildren: false, replay: "strict" },
};
const fixture = createHootProgram({
    source,
    contract: fixtureContract,
    bindOperation(request, site) {
        if (
            !Array.isArray(request) ||
            request[0] !== "elicit" ||
            !fixtureContract.elicits[request[1]]
        ) {
            throw Error("Unsupported fixture effect");
        }
        return {
            kind: "elicit",
            key: request[1],
            message: request[2] ?? request[1],
            response: ANY_JSON_SCHEMA_DESCRIPTOR,
            binding: { id: site },
        };
    },
});
export const { manifest, createDriver: createHootDriver } = fixture;
