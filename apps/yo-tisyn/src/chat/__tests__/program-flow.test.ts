import { describe, expect, it } from "vitest";
import { createProgramFlow } from "../program-flow.ts";

describe("continuation canvas", () => {
  it("distills conditional score arithmetic without hiding the next yield", () => {
    const flow = createProgramFlow(
      'Let("score",Add(1,If(true,1,0)),Ask({"message":"Next round?"}))',
    );
    expect(flow.nodes.map((n) => n.title)).toEqual(["Start", "Ask", "End"]);
    expect(flow.edges).toHaveLength(2);
  });

  it("preserves effects nested in a conditional", () => {
    const flow = createProgramFlow('If(true,Ask({"message":"Play?"}),Throw("Stopped"))');
    expect(flow.nodes.map((n) => n.kind)).toEqual(["entry", "branch", "yield", "exit", "exit"]);
    const fail = flow.nodes.find((n) => n.title === "Fail")!;
    expect(flow.edges.some((e) => e.source === fail.id)).toBe(false);
  });

  it("merges outcomes that resume the same recursive continuation", () => {
    const flow = createProgramFlow(
      'Let("loop",Fn([],Let("answer",Ask({"message":"Again?"}),If(Eq(Get(Ref("answer"),"action"),"accept"),Call(Ref("loop")),Call(Ref("loop"))))),Call(Ref("loop")))',
    );
    const ask = flow.nodes.find((n) => n.title === "Ask")!;
    const routes = flow.edges.filter((e) => e.source === ask.id && e.target === ask.id);
    expect(routes).toHaveLength(1);
    expect(routes[0].label).toContain("accept");
    expect(routes[0].label).toContain("not accept");
  });
});
