// Runtime proof tripwire: deny both ESM and CJS compiler imports.
import { register } from "node:module";
import Module from "node:module";
import vm from "node:vm";
const forbidden =
    /(typescript|@babel|compiled-frames\/compiler|tool-contracts\/compiler|compiled-finally\/artifact|artifact-build\/build\.mjs)/;
const original = Module._load;
Module._load = function (id, ...args) {
    if (forbidden.test(id)) throw Error("Compiler loaded during recovery: " + id);
    return original.call(this, id, ...args);
};
vm.runInNewContext = () => {
    throw Error("Authored module evaluation during recovery");
};
register(
    "data:text/javascript," +
        encodeURIComponent(
            `export async function resolve(id,ctx,next){if(${forbidden}.test(id))throw Error('Compiler loaded during recovery: '+id);return next(id,ctx);}`,
        ),
);
