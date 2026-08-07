import { commands, field, object, program } from "configliere";
import { z } from "zod";

const generateConfig = object({
  input: {
    description: "URL or file path to the MCP manifest",
    aliases: ["-i"],
    ...field(z.string().min(1)),
  },
  output: {
    description: "Output file path for generated types",
    aliases: ["-o"],
    ...field(z.string().min(1)),
  },
  noHeader: {
    description: "Omit the header comment in the generated file",
    ...field(z.boolean(), field.default(false)),
  },
});

export const cliProgram = program({
  name: "sweatpants",
  version: "0.1.0",
  config: commands({
    generate: {
      description: "Generate TypeScript types from an MCP server manifest",
      ...generateConfig,
    },
  }),
});

export function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
