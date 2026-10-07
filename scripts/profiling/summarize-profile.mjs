/** Aggregate self time across callers, without counting a parent's inclusive time twice. */
export function summarizeProfile(profile) {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const frames = new Map();
    let activeMicroseconds = 0;
    if (!profile.samples?.length || profile.samples.length !== profile.timeDeltas?.length) {
        throw new Error("CPU profile is missing aligned samples and durations");
    }
    // V8 can emit samples out of timestamp order. Reconstruct and order them
    // before weighting intervals, as DevTools does in CPUProfileDataModel.
    let timestamp = profile.startTime;
    const samples = profile.samples
        .map((id, index) => {
            const delta = profile.timeDeltas[index];
            timestamp += delta;
            if (
                !nodes.has(id) ||
                !Number.isFinite(delta) ||
                !Number.isFinite(timestamp) ||
                timestamp < profile.startTime
            ) {
                throw new Error("Invalid CPU sample");
            }
            return { id, timestamp };
        })
        .toSorted((a, b) => a.timestamp - b.timestamp);
    let previous = profile.startTime;
    for (const { id, timestamp: sampleTime } of samples) {
        const duration = sampleTime - previous;
        previous = sampleTime;
        const node = nodes.get(id);
        if (node.callFrame.functionName === "(idle)") {
            continue;
        }
        activeMicroseconds += duration;
        const { functionName, url, lineNumber, columnNumber } = node.callFrame;
        const key = JSON.stringify([functionName, url, lineNumber, columnNumber]);
        const aggregate = frames.get(key) ?? { ...node.callFrame, selfMs: 0 };
        aggregate.selfMs += duration / 1000;
        frames.set(key, aggregate);
    }
    return {
        activeMs: activeMicroseconds / 1000,
        elapsedMs: (profile.endTime - profile.startTime) / 1000,
        hottestSelfFrames: [...frames.values()]
            .toSorted((a, b) => b.selfMs - a.selfMs)
            .slice(0, 15),
    };
}
