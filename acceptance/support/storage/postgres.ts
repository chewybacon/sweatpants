import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Own a disposable cluster; never reset or stop a developer's database. */
export async function openTestPostgres() {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-pg-"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing Postgres test port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  // PG_BIN supports macOS/Homebrew and CI; Debian packages expose versioned binaries.
  const versions = await readdir("/usr/lib/postgresql").catch(() => [] as string[]);
  const version = versions.toSorted((a, b) => Number(b) - Number(a))[0];
  const binaries = process.env["PG_BIN"] ?? (version ? `/usr/lib/postgresql/${version}/bin` : "");
  const binary = (name: string) => (binaries ? join(binaries, name) : name);
  let started = false;
  try {
    await execute(binary("initdb"), [
      "-D",
      join(directory, "data"),
      "-A",
      "trust",
      "-U",
      "postgres",
      "--no-locale",
    ]);
    await execute(binary("pg_ctl"), [
      "-D",
      join(directory, "data"),
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      "-w",
      "start",
    ]);
    started = true;
    return {
      connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
      async close() {
        await execute(binary("pg_ctl"), [
          "-D",
          join(directory, "data"),
          "-m",
          "immediate",
          "-w",
          "stop",
        ]);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (started) {
      await execute(binary("pg_ctl"), [
        "-D",
        join(directory, "data"),
        "-m",
        "immediate",
        "-w",
        "stop",
      ]);
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
