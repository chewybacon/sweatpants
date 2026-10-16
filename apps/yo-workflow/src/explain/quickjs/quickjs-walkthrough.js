"use strict";
const root = document.querySelector(".quickjs-explainer");
const $ = (id) => root.querySelector("#" + id);
const SOURCE = "Accepted source + interpreter profile";
const PENDING = "Pending ask #1; stable interaction identity";
const REPLY = "Accepted reply #1: “hello”";
const ECHO = "Accepted echo #1: “hello”";
const RECOVERED = [SOURCE, REPLY, ECHO, "Pending ask #2"];
const steps = {
    round: [
        {
            phase: "Request",
            title: "You ask for a loop",
            copy: "The browser sends your task to the ingress Worker. The Worker routes it to the conversation’s Durable Object. It does not evaluate Tisyn.",
            code: "“Ask me for input in a loop. Echo the accumulated replies until I decline.”",
            nodes: ["browser", "worker", "host"],
            edges: ["ingress", "route"],
            calls: 0,
            vm: "Not created",
            packet: "receive the task",
            browser: "send a task",
        },
        {
            phase: "Author once",
            title: "The model writes Tisyn",
            copy: "Sweatpants asks Haiku to author one program. The answer is Tisyn source with a recursive loop—not JavaScript, and not a new plan for each reply.",
            code: "Source → parse → validate → JSON IR\n\nThe authored loop keeps an accumulator.",
            nodes: ["host", "model"],
            edges: ["model-request", "model-return"],
            calls: 1,
            vm: "Not created",
            packet: "Tisyn source → validated JSON IR",
        },
        {
            phase: "Accept",
            title: "Keep the program, not the VM",
            copy: "Sweatpants preserves the accepted program and its interpreter identity in durable state. D1 is the backing store. The program will not need to be authored again when compute disappears.",
            code: "Durable: source + pinned profile\nTemporary: evaluator memory",
            nodes: ["host", "journal"],
            edges: ["write"],
            calls: 1,
            vm: "Not created",
            journal: [SOURCE],
            packet: "accept the program + profile",
        },
        {
            phase: "Evaluate",
            title: "A fresh bounded evaluator",
            copy: "Inside a tool-executor DO, executor setup installs the evaluation driver. A fresh QuickJS context loads a trusted bundle of the unchanged Tisyn kernel and receives JSON IR.",
            code: "QuickJS executes the kernel.\nThe kernel interprets JSON IR.\nAuthored JavaScript is not accepted.",
            nodes: ["host", "vm"],
            edges: ["run"],
            calls: 1,
            vm: "Running",
            journal: [SOURCE],
            packet: "JSON IR → evaluator",
            bar: 28,
        },
        {
            phase: "Yield",
            title: "Ask for a tool; do not run it",
            copy: "The kernel reaches ask and yields a descriptor. QuickJS returns that descriptor to Sweatpants. The VM has not asked the human anything and does not own tool I/O.",
            code: "Descriptor, simplified:\nask({ message: “Add text?” })",
            nodes: ["vm", "host"],
            edges: ["yield"],
            calls: 1,
            vm: "At a yield",
            journal: [SOURCE],
            packet: "invoke ask({ message: “Add text?” })",
            bar: 28,
        },
        {
            phase: "Dispatch",
            title: "Sweatpants invokes the child",
            copy: "Sweatpants validates the descriptor and invokes the durable ask child through its existing tool-executor adapter. Tool code runs outside the QuickJS VM.",
            code: "VM → descriptor → Sweatpants → ask\n\nNever: VM → direct tool I/O",
            nodes: ["host", "tools", "journal"],
            edges: ["dispatch", "child-return", "write"],
            calls: 1,
            vm: "At a yield",
            journal: [SOURCE, PENDING],
            packet: "invoke durable child: ask #1",
            child: "waiting for you",
        },
        {
            phase: "Park",
            title: "Waiting does not keep a VM alive",
            copy: "Ask needs a human reply, so the workflow parks. The response-stream DO delivers the question to your browser. The temporary evaluator is disposed. The journal preserves the pending interaction.",
            code: "VM: disposed\nPending ask: durable\nHuman wait: no compute budget used",
            nodes: ["journal", "streams", "browser"],
            edges: ["publish", "deliver"],
            calls: 1,
            vm: "Disposed",
            journal: [SOURCE, PENDING],
            packet: "park at the pending interaction",
            browser: "reply form open",
            child: "parked",
        },
        {
            phase: "Reply",
            title: "Your reply becomes durable input",
            copy: "You enter “hello”. The request returns through the Worker to Agent Host. Sweatpants accepts the reply for the pending interaction and records it before resuming the program.",
            code: "Accepted reply: “hello”\nNo model request is needed.",
            nodes: ["browser", "worker", "host", "journal"],
            edges: ["ingress", "route", "write"],
            calls: 1,
            vm: "Disposed",
            journal: [SOURCE, REPLY],
            packet: "accept reply #1: “hello”",
            browser: "“hello”",
            child: "reply accepted",
        },
        {
            phase: "Replay",
            title: "Reconstruct, don’t reauthor",
            copy: "A fresh evaluator runs the same accepted program. Sweatpants supplies recorded outcomes during replay, including the completed ask result. The model stays idle.",
            code: "Same source + accepted outcomes\n→ reconstructed program position",
            nodes: ["journal", "host", "vm"],
            edges: ["read", "run"],
            calls: 1,
            vm: "Recreated",
            journal: [SOURCE, REPLY],
            packet: "resume with accepted ask result",
            browser: "“hello”",
            child: "already accepted",
            bar: 25,
        },
        {
            phase: "Yield",
            title: "Now the program asks to echo",
            copy: "The kernel combines the accepted reply with its accumulator and yields an echo descriptor. Computation is back in the VM; permission and tool dispatch remain with Sweatpants.",
            code: "Descriptor, simplified:\necho({ message: “hello” })",
            nodes: ["vm", "host"],
            edges: ["yield"],
            calls: 1,
            vm: "At a yield",
            journal: [SOURCE, REPLY],
            packet: "invoke echo({ message: “hello” })",
            bar: 31,
        },
        {
            phase: "Effect",
            title: "The child runs, and its result is accepted",
            copy: "Sweatpants invokes the durable echo child outside QuickJS. Its accepted outcome enters the journal. The result can then be supplied back to the evaluator.",
            code: "Sweatpants owns:\nchild identity · dispatch · accepted outcome",
            nodes: ["host", "tools", "journal"],
            edges: ["dispatch", "child-return", "write"],
            calls: 1,
            vm: "At a yield",
            journal: [SOURCE, REPLY, ECHO],
            packet: "accept echo #1: “hello”",
            child: "echo “hello”",
        },
        {
            phase: "Continue",
            title: "Feed the result into the kernel",
            copy: "The accepted child result crosses the JSON bridge back into the evaluator. The recursive call continues with the accumulated text. There is still only one authored program.",
            code: "accepted child result\n→ kernel.next(result)\n→ next iteration",
            nodes: ["host", "vm"],
            edges: ["run"],
            calls: 1,
            vm: "Running",
            journal: [SOURCE, REPLY, ECHO],
            packet: "accepted result → next evaluation step",
            bar: 24,
        },
        {
            phase: "Repeat",
            title: "Ask again. Park again.",
            copy: "The program reaches its next ask. Sweatpants starts the next child and parks again. The evaluator is disposable; the source and accepted work remain. Repeat this cycle for each reply, within the tool-call limit.",
            code: "ask → park → accept reply → replay → echo\n\nModel calls so far: 1",
            nodes: ["host", "tools", "journal", "browser"],
            edges: ["yield", "dispatch", "write", "publish", "deliver"],
            calls: 1,
            vm: "Disposed",
            journal: RECOVERED,
            packet: "pending ask #2; same program",
            browser: "next reply?",
            child: "ask #2 parked",
        },
        {
            phase: "Finish",
            title: "Decline stops the program",
            copy: "Decline or Cancel is accepted as an ask result. On replay, the program follows its stop branch and returns the accumulator. Sweatpants can now ask the model for the final summary: the second model call.",
            code: "Authoring: 1 model call\nBetween rounds: 0\nFinal summary: 1",
            nodes: ["host", "journal", "model", "browser"],
            edges: ["write", "read", "model-request", "model-return", "publish", "deliver"],
            calls: 2,
            vm: "Disposed",
            journal: [SOURCE, REPLY, ECHO, "Accepted decline / cancel", "Completed workflow"],
            packet: "program returned; summarize the result",
            browser: "completed",
            child: "completed",
        },
    ],
    replay: [
        {
            phase: "Checkpoint",
            title: "We are waiting for reply #2",
            copy: "One reply and its echo have already completed. The next ask is parked. The evaluator has already been disposed; durable state holds everything needed to continue.",
            code: "Accepted echo #1: “hello”\nPending: ask #2\nVM: absent",
            nodes: ["journal", "browser"],
            edges: [],
            calls: 1,
            vm: "Disposed",
            journal: RECOVERED,
            packet: "pending ask #2",
            browser: "reply form open",
            child: "ask #2 parked",
        },
        {
            phase: "Replace compute",
            title: "Memory disappears. Work does not.",
            copy: "Imagine replacing the conversation host and tool-executor compute. Their in-memory objects are gone. The durable journal still contains the accepted source, outcomes, and pending interaction identity.",
            code: "Lose: temporary compute state\nKeep: accepted durable state",
            nodes: ["journal"],
            edges: [],
            calls: 1,
            vm: "Absent",
            hostGone: true,
            journal: RECOVERED,
            packet: "host memory replaced",
            browser: "disconnected",
            child: "no live scope",
        },
        {
            phase: "Reconnect",
            title: "The same question comes back",
            copy: "The browser reconnects to a new host scope and reads the durable history. Ask #2 keeps its identity. Reading history does not need a model call or a live evaluator.",
            code: "Same conversation\nSame pending interaction\nNo reauthoring",
            nodes: ["browser", "worker", "host", "journal", "streams"],
            edges: ["ingress", "route", "read", "publish", "deliver"],
            calls: 1,
            vm: "Absent",
            journal: RECOVERED,
            packet: "restore history + pending ask #2",
            browser: "same ask #2",
            child: "ask #2 parked",
        },
        {
            phase: "Accept",
            title: "Reply #2 is recorded",
            copy: "You reply “world”. Sweatpants accepts that input against the restored interaction. Only then does execution need to reconstruct the program’s position.",
            code: "Accepted reply #2: “world”",
            nodes: ["browser", "host", "journal"],
            edges: ["ingress", "route", "write"],
            calls: 1,
            vm: "Absent",
            journal: [SOURCE, REPLY, ECHO, "Accepted reply #2: “world”"],
            packet: "accept “world” for ask #2",
            browser: "“world”",
            child: "reply accepted",
        },
        {
            phase: "Replay accepted work",
            title: "Replay is not a second echo",
            copy: "A fresh evaluator runs the accepted source from the beginning. At previously accepted child calls, Sweatpants supplies the recorded outcomes. It does not run the completed echo child again.",
            code: "ask #1  → recorded “hello”\necho #1 → recorded result; NOT invoked\nask #2  → accepted “world”",
            nodes: ["journal", "host", "vm"],
            edges: ["read", "run"],
            calls: 1,
            vm: "Recreated",
            journal: [SOURCE, REPLY, ECHO, "Accepted reply #2: “world”"],
            packet: "consume recorded outcomes during replay",
            child: "NOT re-run",
            bar: 42,
        },
        {
            phase: "New work",
            title: "Only the next effect is new",
            copy: "The reconstructed program reaches the next echo, which has no accepted outcome yet. Sweatpants dispatches that child and records its result. The program can then ask and park again—without another authoring call.",
            code: "New effect: echo “hello world”\n\nOne source. Accepted history. Fresh compute.",
            nodes: ["host", "vm", "tools", "journal"],
            edges: ["yield", "dispatch", "child-return", "write"],
            calls: 1,
            vm: "At a yield",
            journal: [
                SOURCE,
                REPLY,
                ECHO,
                "Accepted reply #2: “world”",
                "Accepted echo #2: “hello world”",
            ],
            packet: "invoke the next unaccepted child",
            child: "new echo #2",
            bar: 29,
        },
    ],
    guard: [
        {
            phase: "Bad program",
            title: "A valid shape can still run forever",
            copy: "This Tisyn program repeatedly evaluates an empty loop body. It never requests a tool and never returns. Source validation alone cannot guarantee that an admitted program will finish.",
            code: "While(true, [])",
            nodes: ["host", "vm"],
            edges: ["run"],
            calls: 1,
            vm: "Running",
            journal: [SOURCE],
            packet: "evaluate While(true, [])",
            bar: 15,
        },
        {
            phase: "Why placement is not enough",
            title: "A timer cannot interrupt this loop",
            copy: "If the kernel ran directly as synchronous JavaScript, it could block its execution thread without yielding. Effection cancellation and an ordinary timer cannot preempt it. Moving that code into a DO does not solve this.",
            code: "Direct JS: no yield → no timer callback\n\nNode used a node:vm timeout.\nCloudflare does not implement that facility.",
            nodes: ["vm"],
            edges: [],
            calls: 1,
            vm: "Computing",
            journal: [SOURCE],
            packet: "no tool request; no cooperative yield",
            bar: 60,
        },
        {
            phase: "Engine-level guard",
            title: "QuickJS checks its compute budget",
            copy: "The JavaScript engine itself calls an interrupt handler while executing. That handler counts checks within this evaluation advance. It does not depend on a timer firing or on the Workers clock advancing.",
            code: "Per advance:\n256 interrupt checks allowed\nInterrupt when that budget is exceeded",
            nodes: ["vm"],
            edges: [],
            calls: 1,
            vm: "Budget exceeded",
            journal: [SOURCE],
            packet: "engine interrupt budget exceeded",
            bar: 100,
            failed: true,
        },
        {
            phase: "Explicit failure",
            title: "Return an error, not a fake success",
            copy: "The evaluator reports the limit failure to Sweatpants. The durable tool fails explicitly. No child tool ran, and Agent Host does not silently ask the model to replace this failed program.",
            code: "tisyn_evaluation_failed\n\nNot: a successful empty result\nNot: another runtime or model fallback",
            nodes: ["vm", "host", "journal"],
            edges: ["yield", "write"],
            calls: 1,
            vm: "Failed",
            journal: [SOURCE, "Workflow failed: compute limit"],
            packet: "explicit evaluation failure",
            child: "never invoked",
            bar: 100,
            failed: true,
        },
        {
            phase: "Release",
            title: "Dispose of the failed evaluator",
            copy: "Scope cleanup releases the temporary VM. A subsequent valid evaluation can start in a fresh context. Memory and stack limits provide other explicit failure paths. These are VM bounds, not a whole-DO quota or a security audit.",
            code: "VM disposed\nAccepted history preserved\nFresh evaluation can start later",
            nodes: ["host", "journal"],
            edges: ["publish", "deliver"],
            calls: 1,
            vm: "Disposed",
            journal: [SOURCE, "Workflow failed: compute limit"],
            packet: "close evaluator; report failure",
            browser: "visible error",
            child: "never invoked",
            failed: true,
        },
    ],
};
const components = {
    browser: [
        "Your browser",
        "Sends tasks and typed replies. Displays the program plan, tool cards, and pending interactions. It does not run the Tisyn evaluator. A browser reload is not the same as replacing server compute.",
    ],
    worker: [
        "Ingress Worker · routing only",
        "Accepts HTTP traffic and forwards it to the conversation DO. QuickJS and Agent Host do not execute here. Moving work into DOs changes placement, but does not make synchronous code cooperatively interruptible.",
    ],
    model: [
        "Model provider · author, then summarize",
        "Haiku writes one Tisyn program. Its source is parsed and validated before execution. Human replies and child results drive the loop without further model authoring. A model can summarize after the program finishes.",
    ],
    host: [
        "Sweatpants · durable control",
        "Agent Host runs inside a conversation DO. Sweatpants owns scheduling, tool lifetimes, child identities, accepted outcomes, parking, and recovery. The journal authority uses D1; in-memory host objects are replaceable.",
    ],
    vm: [
        "QuickJS · bounded temporary compute",
        "QuickJS is a JavaScript engine compiled to WebAssembly. It executes a fixed trusted bundle of the published Tisyn kernel. Authored input enters as JSON IR. It yields descriptors and consumes results; it does not own the journal or tool I/O.",
    ],
    tools: [
        "Durable tools · outside QuickJS",
        "The tisyn parent and ask/echo children use the existing Cloudflare durable executor adapter. Native child-tool code runs outside the VM. There are no ordinary tools in this app requiring the separate ToolSessions DO adapter.",
    ],
    journal: [
        "D1 · durable truth",
        "Accepted source, interpreter identity, outcomes, and pending work survive compute replacement. Replay consumes that accepted history. The VM is not a second journal or a replacement for Sweatpants’s runtime.",
    ],
    streams: [
        "ResponseStream DO · UI delivery",
        "Stores and serves replayable response updates so the client can reconnect. This is delivery, not another execution authority. The execution journal remains the durable authority.",
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
    $("model-count").textContent = s.calls;
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
