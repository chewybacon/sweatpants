from pathlib import Path
p = Path(__file__).parent
source = (p/'runtime/reflect.js').read_text()
# Hoot 0.9.0 upstream assumes sloppy-mode JS in its DWARF formatter.
source = source.replace('for (attr in map)', 'for (const attr in map)')
old = 'return reflect.#init_module(mod);'
assert source.count(old) == 1
source = source.replace(old, 'const values = reflect.#init_module(mod);\n        values.fuel = mod.all_exports().__fuel;\n        return values;')
(p/'runtime/reflect-restricted.cjs').write_text(source)
a = source.index('function instantiate_streaming(path, imports) {')
b = source.index('\nclass IterableWeakSet', a)
source = source[:a] + '''async function instantiate_streaming(path, imports) {
    const module = modules[path.split('/').pop()];
    if (!module) throw new Error(`Unknown bundled WASM module: ${path}`);
    return { module, instance: await WebAssembly.instantiate(module, imports) };
}
''' + source[b:]
source = '''import kernel from './restricted.wasm';
import reflect from './reflect.wasm';
import wtf8 from './wtf8.wasm';
const modules = {'restricted.wasm': kernel, 'reflect.wasm': reflect, 'wtf8.wasm': wtf8};
const window = {};
''' + source + '\nexport { Scheme };\n'
(p/'runtime/reflect-restricted.mjs').write_text(source)
