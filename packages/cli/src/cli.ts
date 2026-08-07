/**
 * @sweatpants/cli
 *
 * CLI for generating TypeScript types from MCP servers with x-sweatpants extensions.
 */

import { cliProgram, environment } from "./cli-config.ts";
import { generate } from "./commands/generate.ts";

const parsed = cliProgram.parse({
  args: process.argv.slice(2),
  envs: [{ name: "environment", value: environment() }],
});

if (!parsed.ok) {
  console.error(parsed.error.message);
  console.error(`\n${cliProgram.help()}`);
  process.exitCode = 1;
} else if (parsed.value.help) {
  console.log(cliProgram.help());
} else if (parsed.value.version) {
  console.log(parsed.value.version);
} else if (parsed.value.config.help) {
  console.log(parsed.value.config.text);
} else if (parsed.value.config.name !== "generate") {
  console.error(`Unknown command: ${parsed.value.config.name}`);
  process.exitCode = 1;
} else if (parsed.remainder.args && parsed.remainder.args.length > 0) {
  console.error(`Unexpected arguments: ${parsed.remainder.args.join(" ")}`);
  console.error(`\n${cliProgram.help()}`);
  process.exitCode = 1;
} else {
  try {
    await generate(parsed.value.config.config);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
