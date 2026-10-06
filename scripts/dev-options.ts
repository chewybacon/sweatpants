/** Match Vite's last explicit mode, in either supported CLI form. */
export function readMode(args: readonly string[]): string {
  let mode = "development";
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--mode" || argument === "-m") {
      const value = args[++i];
      if (!value || value.startsWith("-")) {
        throw new Error("--mode requires a value");
      }
      mode = value;
    } else if (argument.startsWith("--mode=")) {
      mode = argument.slice("--mode=".length);
      if (!mode) {
        throw new Error("--mode requires a value");
      }
    }
  }
  return mode;
}
