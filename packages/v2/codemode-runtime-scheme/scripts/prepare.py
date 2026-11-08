from pathlib import Path
import sys
out=Path(sys.argv[1])
src=(out/'reflect.js').read_text().replace('for (attr in map)','for (const attr in map)')
old='return reflect.#init_module(mod);'
assert src.count(old)==1
src=src.replace(old,'const values = reflect.#init_module(mod); values.fuel = mod.all_exports().__fuel; return values;')
(out/'reflect.cjs').write_text(src)
a=src.index('function instantiate_streaming(path, imports) {');b=src.index('\nclass IterableWeakSet',a)
worker=src[:a]+'''async function instantiate_streaming(path, imports) {
 const module = modules[path.split('/').pop()];
 if (!module) throw new Error('Unknown Scheme WASM module: ' + path);
 return {module, instance: await WebAssembly.instantiate(module, imports)};
}
'''+src[b:]
worker=worker[:worker.index("// Modulize when possible.")]
worker="""import kernel from '#scheme-kernel-wasm';
import reflect from '#scheme-reflect-wasm';
import wtf8 from '#scheme-wtf8-wasm';
const modules = {'kernel.wasm':kernel,'reflect.wasm':reflect,'wtf8.wasm':wtf8};
const window = {};
"""+worker+'\nexport { Scheme };\n'
(out/'reflect-worker.mjs').write_text(worker)
