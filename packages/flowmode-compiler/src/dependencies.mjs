import ts from "typescript";
import { resolve } from "node:path";

/** Local source/type imports admitted by the frontend participate in Vite invalidation.
 * Package imports are SDK/compiler inputs managed by the package build graph.
 * @param {string} source
 * @param {string} id
 * @returns {string[]}
 */
export function workflowSourceDependencies(source, id) {
  const visited = new Set([resolve(id)]);
  const dependencies = [];
  function visit(text, filename) {
    for (const imported of ts.preProcessFile(text).importedFiles) {
      if (!imported.fileName.startsWith(".")) {
        continue;
      }
      const found = ts.resolveModuleName(
        imported.fileName,
        filename,
        {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        },
        ts.sys,
      ).resolvedModule;
      if (!found || visited.has(found.resolvedFileName)) {
        continue;
      }
      visited.add(found.resolvedFileName);
      dependencies.push(found.resolvedFileName);
      const content = ts.sys.readFile(found.resolvedFileName);
      if (content !== undefined) {
        visit(content, found.resolvedFileName);
      }
    }
  }
  visit(source, resolve(id));
  return dependencies;
}
