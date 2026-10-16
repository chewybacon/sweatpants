// Scheme exact rationals preserve the IEEE-754 value without decimal reader drift.
export function encodeNumber(value) {
    if (!Number.isFinite(value)) throw Error("Nonfinite number");
    if (Number.isSafeInteger(value)) return String(value);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 2047n);
    let numerator = bits & ((1n << 52n) - 1n);
    if (exponent) numerator |= 1n << 52n;
    let shift = (exponent || 1) - 1023 - 52;
    while (shift < 0 && numerator % 2n === 0n) {
        numerator >>= 1n;
        shift++;
    }
    if (bits >> 63n) numerator = -numerator;
    return shift >= 0 ? String(numerator << BigInt(shift)) : `${numerator}/${1n << BigInt(-shift)}`;
}

export function decodeRational(text) {
    let [n, d] = text.split("/").map(BigInt);
    if (d === 0n) throw Error("Invalid rational");
    const negative = n < 0n !== d < 0n;
    if (n < 0n) n = -n;
    if (d < 0n) d = -d;
    if (!n) return 0;
    let exponent = n.toString(2).length - d.toString(2).length;
    if (exponent >= 0 ? n < d << BigInt(exponent) : n << BigInt(-exponent) < d) exponent--;
    const shift = Math.max(exponent - 52, -1074);
    const numerator = shift < 0 ? n << BigInt(-shift) : n;
    const denominator = shift > 0 ? d << BigInt(shift) : d;
    let q = numerator / denominator;
    const remainder = numerator % denominator;
    if (2n * remainder > denominator || (2n * remainder === denominator && q % 2n)) q++;
    const value = Number(q) * 2 ** shift;
    if (!Number.isFinite(value)) throw Error("Nonfinite number");
    return negative ? -value : value;
}
