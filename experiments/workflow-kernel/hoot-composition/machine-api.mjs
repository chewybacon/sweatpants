import { inspectSnapshot } from "./inspect.mjs";
import { encodeValue, decodeValue } from "../scheme-data/values.mjs";
export function machineApi(procedures) {
    function call(index, ...args) {
        procedures.fuel.value = 100_000_000n;
        try {
            return procedures[index]
                .call(...args)
                .map((value) =>
                    value &&
                    typeof value === "object" &&
                    typeof value.reflector?.string_value === "function"
                        ? value.reflector.string_value(value)
                        : value,
                );
        } catch (cause) {
            procedures.fuel.value = 100_000_000n;
            const value = procedures[6].call()[0];
            const diagnostic =
                value &&
                typeof value === "object" &&
                typeof value.reflector?.string_value === "function"
                    ? value.reflector.string_value(value)
                    : value;
            throw new Error(
                typeof diagnostic === "string" && diagnostic
                    ? diagnostic
                    : "Workflow evaluator failed",
                { cause },
            );
        }
    }
    function boundary(values) {
        const [kind, site, data] = values;
        return { kind, site, value: decodeValue(data) };
    }
    return {
        validate: (source) => call(7, source)[0],
        start: (source, input = null) => boundary(call(0, source, encodeValue(input))),
        resume: (value) => boundary(call(1, encodeValue(value))),
        reject: (error) => boundary(call(5, encodeValue(error))),
        cancel: () => boundary(call(2)),
        capture: () => call(3)[0],
        inspect: () => inspectSnapshot(call(3)[0]),
        restore: (source, snapshot) => boundary(call(4, source, snapshot)),
    };
}
