// These tools consume the JavaScript compiler API, rather than invoking tsc.
const compilerApiConsumers = new Set([
  "@astrojs/check",
  "@shikijs/twoslash",
  "@typescript/ata",
  "@typescript/vfs",
  "@volar/kit",
  "tsconfck",
  "tsup",
  "twoslash",
  "twoslash-vue",
]);

module.exports = {
  hooks: {
    readPackage(pkg) {
      const typescript = pkg.peerDependencies?.typescript;
      if (typescript && compilerApiConsumers.has(pkg.name)) {
        // TypeScript 7's native compiler replaces the JavaScript compiler API.
        // Keep API-based tools on their newest compatible JavaScript release;
        // workspace tsc commands use the TypeScript 7 catalog dependency.
        // tsup's declaration worker still injects baseUrl, rejected by TS 6.
        const ceiling = pkg.name === "tsup" ? "<6" : "<7";
        const compilerApi = typescript
          .split("||")
          .map((range) => `${range.trim()} ${ceiling}`)
          .join(" || ");
        pkg.dependencies = { ...pkg.dependencies, typescript: compilerApi };
        delete pkg.peerDependencies.typescript;
        if (pkg.peerDependenciesMeta) {
          delete pkg.peerDependenciesMeta.typescript;
        }
      }
      return pkg;
    },
  },
};
