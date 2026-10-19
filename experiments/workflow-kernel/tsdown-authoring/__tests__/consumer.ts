import { reviewDraft } from "../dist/review-draft.workflow.artifact.mjs";
type Contract = NonNullable<typeof reviewDraft.types>;
const input: Contract["input"] = { title: "Launch", recipient: "Sam", metadata: null };
const output: Contract["output"] = "Draft approved";
// @ts-expect-error the compiled import retains required input properties
const missingRecipient: Contract["input"] = { title: "Launch", metadata: null };
// @ts-expect-error the generator's literal return union survives the build
const invalidOutput: Contract["output"] = "Anything goes";
void [input, output, missingRecipient, invalidOutput];
