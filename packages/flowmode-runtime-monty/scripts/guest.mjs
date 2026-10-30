import { readFile, writeFile } from "node:fs/promises";
const anyio = await readFile(new URL("../guest/anyio.py", import.meta.url), "utf8");
const error = await readFile(new URL("../guest/error.py", import.meta.url), "utf8");
const library = await readFile(new URL("../guest/workflow.py", import.meta.url), "utf8");
const cleanup = await readFile(new URL("../guest/cleanup.py", import.meta.url), "utf8");
const demo = await readFile(new URL("../guest/demo.py", import.meta.url), "utf8");
await writeFile(
  new URL("../src/guest.mjs", import.meta.url),
  `// Generated from guest/*.py; regenerate with scripts/guest.mjs.\nexport const guestLibrary = ${JSON.stringify(library)};\nexport const demoSource = ${JSON.stringify(demo)};\nexport const cleanupSource = ${JSON.stringify(cleanup)};\nexport const errorSource = ${JSON.stringify(error)};\nexport const anyioSource = ${JSON.stringify(anyio)};\n`,
);
