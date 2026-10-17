"use strict";
const root = document.querySelector(".runtime-explainer");
const $ = (id) => root.querySelector("#" + id);
const steps = {
    round: [
        {
            phase: "Request",
            title: "A task enters the conversation",
            copy: "The browser sends a command through the ingress Worker to the conversation Durable Object. The host coordinates the turn and journal authority.",
            code: "Browser \u2192 Worker \u2192 conversation host",
            nodes: ["browser", "worker", "host"],
            edges: ["ingress", "route"],
            vm: "Not created",
            journal: [],
            calls: "\u2014",
            packet: "Request",
        },
        {
            phase: "Author",
            title: "The model writes a named Scheme program",
            copy: "The configured model receives the generated language reference and installed tool contracts. It submits a title, one Scheme expression, and optional JSON input. Authoring may take several calls.",
            code: '{ title: "Collect replies",\n  program: "(let loop (...) ...)",\n  input: {...}, validateOnly: true }',
            nodes: ["host", "model"],
            edges: ["model-request", "model-return"],
            vm: "Not created",
            journal: [],
            calls: "\u2014",
            packet: "Author",
        },
        {
            phase: "Validate",
            title: "Compile without running effects",
            copy: "Hoot reads and expands the expression and checks bindings and known call arities. Validation does not prove termination or validate every runtime effect request.",
            code: "read \u2192 expand \u2192 bindings \u2192 known arities\nNo ask, document mutation, or model sampling",
            nodes: ["host", "vm"],
            edges: ["run", "yield"],
            vm: "Checking",
            journal: [],
            calls: "\u2014",
            packet: "Validate",
        },
        {
            phase: "Repair",
            title: "Return actionable diagnostics",
            copy: "The tool returns a structured diagnostic to the authoring model. Unknown names, arity errors, reader errors, and compiler fuel exhaustion are distinct. A successful fragment check does not validate an assembled program.",
            code: 'Unbound identifier: display_document\nUse (effect "display_document" request).\nValidate the complete repaired source.',
            nodes: ["vm", "host", "model"],
            edges: ["yield", "model-request", "model-return"],
            vm: "Disposed",
            journal: [],
            calls: "\u2014",
            packet: "Repair",
        },
        {
            phase: "Execute",
            title: "Run the validated source",
            copy: "The model submits the same complete source for execution. The journal records the tool invocation; the Scheme adapter creates a fresh metered evaluator inside a tool executor.",
            code: "Scheme source + explicit input\n\u2192 fresh Hoot Wasm instance",
            nodes: ["host", "journal", "vm"],
            edges: ["write", "run"],
            vm: "Running",
            journal: ["Accepted source, input, and program identity"],
            calls: "\u2014",
            packet: "Execute",
        },
        {
            phase: "Yield",
            title: "An effect crosses the boundary",
            copy: "Scheme computes until it emits an effect description. The adapter validates its request and uses the host capability for that effect. Ask runs as a durable child; random and sampling have their own handlers.",
            code: '(ask (object (cons "message" "Add text?")))\n\u2192 { id: "ask", data: {...} }',
            nodes: ["vm", "host", "tools"],
            edges: ["yield", "dispatch"],
            vm: "Running",
            journal: ["Accepted source, input, and program identity"],
            calls: "\u2014",
            packet: "Yield",
            child: "ask started",
        },
        {
            phase: "Park",
            title: "The question outlives the evaluator",
            copy: "Ask waits for a human. The journal retains the pending interaction and the response stream delivers the form. Compute can be released while the workflow is parked.",
            code: "Pending interaction: durable\nEvaluator memory: disposable",
            nodes: ["host", "journal", "streams", "browser"],
            edges: ["write", "publish", "deliver"],
            vm: "Disposed",
            journal: [
                "Accepted source, input, and program identity",
                "Pending ask; stable interaction identity",
            ],
            calls: "\u2014",
            packet: "Park",
            child: "waiting for you",
            browser: "reply form open",
        },
        {
            phase: "Accept reply",
            title: "A reply becomes recorded input",
            copy: "The host accepts the reply against the pending interaction. Recovering the Playground can reconstruct the program in fresh compute and supply accepted results.",
            code: "Reply \u2192 authority \u2192 recorded result\nNo new authoring call required",
            nodes: ["browser", "worker", "host", "journal"],
            edges: ["ingress", "route", "write"],
            vm: "Disposed",
            journal: ["Accepted source, input, and program identity", "Accepted human reply"],
            calls: "\u2014",
            packet: "Accept reply",
        },
        {
            phase: "Continue",
            title: "Values drive the next effect",
            copy: "The evaluator receives the result. Pure Scheme chooses the next branch or loop iteration. The host executes the next unrecorded effect and records its outcome.",
            code: "accepted reply \u2192 evaluator.next(value)\n\u2192 echo request \u2192 accepted echo result",
            nodes: ["host", "vm", "tools", "journal"],
            edges: ["read", "run", "yield", "dispatch", "child-return", "write"],
            vm: "Running",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted human reply",
                "Accepted echo result",
            ],
            calls: "\u2014",
            packet: "Continue",
            child: "new echo",
        },
        {
            phase: "Finish or repeat",
            title: "The program decides what happens next",
            copy: "The same program may ask again or return a value. Decline is a value that authored code handles; cancelling the workflow is a host control operation. When the tool returns, the outer model can summarize its result.",
            code: "Loop: ask \u2192 reply \u2192 next iteration\nReturn: tool result \u2192 model summary\nExplicit sample/decision effects may call models within the loop.",
            nodes: ["host", "model", "journal", "browser"],
            edges: ["write", "model-request", "model-return", "publish", "deliver"],
            vm: "Disposed",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted human reply",
                "Accepted echo result",
                "Returned workflow result",
            ],
            calls: "\u2014",
            packet: "Finish or repeat",
        },
    ],
    replay: [
        {
            phase: "Parked",
            title: "Accepted history is the recovery input",
            copy: "The Playground has completed an ask and echo and is waiting at a second ask. No live evaluator is required to display that question.",
            code: "Source + input + accepted outcomes\nPending ask #2",
            nodes: ["journal", "browser"],
            edges: [],
            vm: "Absent",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted human reply",
                "Accepted echo result",
                "Pending ask #2",
            ],
            calls: "\u2014",
            packet: "Parked",
        },
        {
            phase: "Replace compute",
            title: "Process memory can disappear",
            copy: "Host and executor objects are replaceable. The accepted journal remains authoritative. UI response streams provide delivery, not execution authority.",
            code: "Lose evaluator memory\nKeep accepted work",
            nodes: ["journal"],
            edges: [],
            vm: "Absent",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted human reply",
                "Accepted echo result",
                "Pending ask #2",
            ],
            calls: "\u2014",
            packet: "Replace compute",
            hostGone: true,
        },
        {
            phase: "Reconnect",
            title: "Restore the question from history",
            copy: "The browser reads the conversation projection and pending interaction. This does not execute Scheme or ask a model to recreate the program.",
            code: "Same interaction identity\nSame accepted history",
            nodes: ["browser", "worker", "host", "journal", "streams"],
            edges: ["ingress", "route", "read", "publish", "deliver"],
            vm: "Absent",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted human reply",
                "Accepted echo result",
                "Pending ask #2",
            ],
            calls: "\u2014",
            packet: "Reconnect",
        },
        {
            phase: "Reconstruct",
            title: "Replay pure computation with recorded results",
            copy: "The current Playground adapter reruns accepted source in a fresh evaluator. Previously completed effects receive their recorded outcomes instead of performing their external work again.",
            code: "ask #1 \u2192 recorded reply\necho #1 \u2192 recorded outcome\nask #2 \u2192 newly accepted reply",
            nodes: ["journal", "host", "vm"],
            edges: ["read", "run"],
            vm: "Recreated",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted human reply",
                "Accepted echo result",
                "Accepted reply #2",
            ],
            calls: "\u2014",
            packet: "Reconstruct",
            child: "completed effects reused",
        },
        {
            phase: "Advance",
            title: "Only unaccepted work is new",
            copy: "At the next effect without an accepted result, the host performs new work. This path reconstructs computation; it does not restore an evaluator heap snapshot.",
            code: "Replay accepted prefix\n\u2192 execute next effect\n\u2192 record outcome",
            nodes: ["host", "vm", "tools", "journal"],
            edges: ["yield", "dispatch", "child-return", "write"],
            vm: "Running",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted human reply",
                "Accepted echo result",
                "Accepted reply #2",
                "New effect outcome",
            ],
            calls: "\u2014",
            packet: "Advance",
        },
        {
            phase: "Checkpoint alternative",
            title: "The Execution lab saves the evaluator itself",
            copy: "The experimental kernel backend captures environments, continuation frames and pending cleanup. Restore checks identity and journal provenance, rebuilds state, then applies accepted history after the checkpoint. Follow the link below to inspect real checkpoint data.",
            code: "Accepted checkpoint envelope\n\u2192 restore evaluator state\n\u2192 apply accepted suffix\n\u2192 resume saved continuation",
            nodes: ["journal", "host", "vm"],
            edges: ["read", "run"],
            vm: "Recreated",
            journal: [
                "Accepted source, input, and program identity",
                "Accepted evaluator checkpoint",
                "Accepted entries after checkpoint",
            ],
            calls: "\u2014",
            packet: "Checkpoint alternative",
        },
    ],
    guard: [
        {
            phase: "Unbounded source",
            title: "Valid syntax can still loop forever",
            copy: "Compilation accepts this recursive loop, but evaluating it never returns or yields an effect. A separate execution budget is necessary.",
            code: "(let loop () (loop))",
            nodes: ["host", "vm"],
            edges: ["run"],
            vm: "Computing",
            journal: ["Accepted source, input, and program identity"],
            calls: "\u2014",
            packet: "Unbounded source",
            bar: 20,
        },
        {
            phase: "Metered Wasm",
            title: "Fuel is checked inside computation",
            copy: "The built Wasm is instrumented with fuel checks. Synchronous computation can exhaust that counter without relying on a JavaScript timer. Validation, each advance, and the evaluator lifetime have separate budgets.",
            code: "Metered Wasm calls consume fuel\nCounter exhaustion traps computation\nFuel is not a count of Scheme expressions",
            nodes: ["vm"],
            edges: [],
            vm: "Computing",
            journal: ["Accepted source, input, and program identity"],
            calls: "\u2014",
            packet: "Metered Wasm",
            bar: 75,
        },
        {
            phase: "Report",
            title: "Surface the failure and accepted work",
            copy: "A validation limit produces E_VALIDATION_FUEL. Execution fuel exhaustion becomes a failed Scheme result with a diagnostic and completed-effect count. The outer author may repair it; already accepted effects remain recorded.",
            code: '{ status: "failed", diagnostic: {...},\n  completedEffects: n, recovery: {...} }\nDo not blindly repeat external mutations.',
            nodes: ["vm", "host", "journal"],
            edges: ["yield", "write"],
            vm: "Failed",
            journal: ["Accepted source, input, and program identity", "Recorded failed result"],
            calls: "\u2014",
            packet: "Report",
            bar: 100,
            failed: true,
        },
        {
            phase: "Release",
            title: "Fresh compute keeps its own limits",
            copy: "The failed evaluator is closed. A later invocation receives a fresh bounded instance. Metering is not a whole-process memory limit, and validation cannot prove that every program terminates.",
            code: "Close evaluator\nPreserve accepted history\nReport failure to the caller",
            nodes: ["host", "journal", "browser"],
            edges: ["publish", "deliver"],
            vm: "Disposed",
            journal: ["Accepted source, input, and program identity", "Recorded failed result"],
            calls: "\u2014",
            packet: "Release",
            failed: true,
        },
    ],
};
const components = {
    browser: [
        "Your browser",
        "Displays journal-backed conversation projections, program source, ordered tool activity and pending input. Replies become commands to the host; the browser does not evaluate Scheme.",
    ],
    worker: [
        "Ingress Worker",
        "Routes requests to the conversation Durable Object. Deployment placement is separate from evaluation and journal authority.",
    ],
    model: [
        "Authoring and explicit model effects",
        "The outer model authors, validates and repairs Scheme, then consumes its final result. Programs may explicitly request sampling or decisions. Deterministic loop steps do not inherently require a model call.",
    ],
    host: [
        "Host and journal authority",
        "Coordinates commands, child lifetimes, effect acceptance, parking and recovery. D1 stores accepted durable state. Tool execution is separate from the authority.",
    ],
    vm: [
        "Hoot Scheme evaluator",
        "Compiles Scheme inside metered WebAssembly, computes pure expressions, and yields effect descriptions. The Playground adapter reconstructs computation through replay; the experimental kernel backend additionally supports evaluator snapshots.",
    ],
    tools: [
        "Native tools and effect handlers",
        "Ask and document tools execute outside the evaluator. The Scheme adapter validates requests and dispatches through the existing runtime. Random, sampling and decision effects have explicit handlers.",
    ],
    journal: [
        "D1-backed durable state",
        "Accepted invocations, results, interaction identities and conversation projections survive compute replacement. Only journal-accepted work is authoritative. An evaluator snapshot is useful only when its envelope and provenance are accepted.",
    ],
    streams: [
        "ResponseStream Durable Object",
        "Retains response updates for delivery and reconnection. It is not the journal authority and does not execute the program.",
    ],
};
let scenario = "round",
    index = 0,
    playing = false,
    timer,
    zoom = 1;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
// All paths are static, local illustration data; no external requests or authored evaluation.
for (const group of root.querySelectorAll("[data-flow]")) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "packet");
    dot.setAttribute("r", "4");
    const motion = document.createElementNS(dot.namespaceURI, "animateMotion");
    motion.setAttribute("dur", "2.4s");
    motion.setAttribute("repeatCount", "indefinite");
    const link = document.createElementNS(dot.namespaceURI, "mpath");
    link.setAttribute("href", "#edge-" + group.dataset.flow);
    motion.append(link);
    dot.append(motion);
    group.append(dot);
}
function inspect(name) {
    const [title, copy] = components[name];
    $("inspect-title").textContent = title;
    $("inspect-copy").textContent = copy;
    root.querySelectorAll("[data-node]").forEach((node) =>
        node.classList.toggle("selected", node.dataset.node === name),
    );
}
function render() {
    const list = steps[scenario],
        s = list[index];
    $("phase").textContent = s.phase;
    $("step-title").textContent = s.title;
    $("step-copy").textContent = s.copy;
    $("step-code").textContent = s.code;
    $("model-count").textContent = s.nodes.includes("model")
        ? "Author / repair / summarize"
        : "No model in this step";
    $("vm-metric").textContent = s.vm;
    $("vm-state").textContent = s.vm.toUpperCase();
    $("packet-value").textContent = s.packet;
    $("browser-state").textContent = s.browser ?? "connected";
    $("child-state").textContent = s.child ?? "not running";
    $("guard-bar").setAttribute("width", String((s.bar ?? 0) * 1.67));
    $("guard-bar").setAttribute("aria-label", "Illustrative compute activity, not a measurement");
    $("journal-list").replaceChildren(
        ...(s.journal ?? []).map((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            return li;
        }),
    );
    $("journal-empty").hidden = !!s.journal?.length;
    root.querySelectorAll("[data-node]").forEach((node) => {
        const name = node.dataset.node;
        node.classList.toggle("active", s.nodes.includes(name));
        node.classList.toggle(
            "absent",
            (name === "vm" && ["Disposed", "Absent", "Not created"].includes(s.vm)) ||
                (name === "host" && !!s.hostGone),
        );
        node.classList.toggle("failed", name === "vm" && !!s.failed);
        node.classList.toggle(
            "computing",
            name === "vm" && ["Running", "Computing", "Recreated"].includes(s.vm),
        );
    });
    root.querySelectorAll("[data-flow]").forEach((edge) =>
        edge.classList.toggle("active", s.edges.includes(edge.dataset.flow)),
    );
    root.querySelectorAll("[data-scenario]").forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.scenario === scenario)),
    );
    $("step-count").textContent = `${index + 1} / ${list.length}`;
    $("scrub").max = list.length - 1;
    $("scrub").value = index;
    $("scrub").setAttribute("aria-valuetext", `${index + 1}: ${s.title}`);
    $("back").disabled = index === 0;
    $("next").disabled = index === list.length - 1;
    $("play").textContent = playing ? "Ⅱ Pause" : "▶ Play";
    $("play").setAttribute("aria-label", playing ? "Pause walkthrough" : "Play walkthrough");
    root.classList.toggle("motion-paused", !playing);
    $("map").pauseAnimations();
    if (playing && !reduced.matches) {
        $("map").unpauseAnimations();
    }
}
function stop() {
    clearTimeout(timer);
    playing = false;
}
function schedule() {
    clearTimeout(timer);
    if (!playing) {
        return;
    }
    timer = setTimeout(
        () => {
            if (index < steps[scenario].length - 1) {
                index++;
                if (index === steps[scenario].length - 1) {
                    playing = false;
                }
                render();
                schedule();
            }
        },
        Number($("speed").value),
    );
}
function move(next) {
    stop();
    index = Math.max(0, Math.min(steps[scenario].length - 1, next));
    render();
}
$("play").addEventListener("click", () => {
    if (playing) {
        stop();
    } else {
        if (index === steps[scenario].length - 1) {
            index = 0;
        }
        playing = true;
    }
    render();
    schedule();
});
$("back").addEventListener("click", () => move(index - 1));
$("next").addEventListener("click", () => move(index + 1));
$("reset").addEventListener("click", () => move(0));
$("scrub").addEventListener("input", (e) => move(Number(e.target.value)));
$("speed").addEventListener("change", schedule);
for (const button of root.querySelectorAll("[data-scenario]")) {
    button.addEventListener("click", () => {
        scenario = button.dataset.scenario;
        move(0);
    });
}
for (const node of root.querySelectorAll("[data-node]")) {
    node.addEventListener("click", () => inspect(node.dataset.node));
    node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inspect(node.dataset.node);
        }
    });
}
function setZoom(value) {
    zoom = Math.max(0.8, Math.min(4, value));
    $("map").style.minWidth = "0";
    $("map").style.width = `${zoom * 100}%`;
    if (zoom === 1) {
        $("diagram-scroll").scrollTo({ left: 0, top: 0 });
    }
}
function currentZoom() {
    return $("map").getBoundingClientRect().width / $("diagram-scroll").clientWidth;
}
$("zoom-in").addEventListener("click", () => setZoom(currentZoom() + 0.2));
$("zoom-out").addEventListener("click", () => setZoom(currentZoom() - 0.2));
$("zoom-fit").addEventListener("click", () => setZoom(1));
document.addEventListener("keydown", (e) => {
    if (e.target.matches("input,select,textarea") || e.altKey || e.ctrlKey || e.metaKey) {
        return;
    }
    if (e.key === "ArrowRight") {
        e.preventDefault();
        move(index + 1);
    }
    if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(index - 1);
    }
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        stop();
        render();
    }
});
reduced.addEventListener("change", render);
render();
