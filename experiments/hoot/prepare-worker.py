from pathlib import Path
p = Path(__file__).parent
source = (p / 'runtime/reflect.js').read_text()
a = source.index('function instantiate_streaming(path, imports) {')
b = source.index('\nclass IterableWeakSet', a)
source = source[:a] + '''async function instantiate_streaming(path, imports) {
    const module = modules[path.split('/').pop()];
    if (!module) throw new Error(`Unknown bundled WASM module: ${path}`);
    return { module, instance: await WebAssembly.instantiate(module, imports) };
}
''' + source[b:]
source = '''// Generated platform adapter: bundled modules and browser-style (no filesystem) I/O.
import kernel from './kernel.wasm';
import reflect from './reflect.wasm';
import wtf8 from './wtf8.wasm';
const modules = {'kernel.wasm': kernel, 'reflect.wasm': reflect, 'wtf8.wasm': wtf8};
const window = {};
''' + source + '\nexport { Scheme };\n'
(p / 'runtime/reflect-worker.mjs').write_text(source)
