import { describe, expect, it } from "vitest";
import { parseDSL } from "@tisyn/dsl";
import { createProgramPlan } from "../program-plan.ts";

const workflow = `Seq(Eval("echo",{"message":"hello"}),Let("r",Eval("ask",{"message":"What next?"}),If(Eq(Get(Ref("r"),"action"),"accept"),Eval("echo",{"message":Get(Get(Ref("r"),"content"),"reply")}),Ref("r"))))`;

describe("Tisyn program plan", () => {
  it("shows sequence, bindings and both branches without claiming an execution trace", () => {
    const plan = createProgramPlan(workflow);
    expect(plan.steps).toEqual([
      'Echo "hello"',
      'Ask "What next?"',
      "Save as r",
      '(r.action = "accept")',
      "Echo r.content.reply",
      "Value r",
      "Program result",
    ]);
    expect(plan.diagram).toContain("n0 --> n1");
    expect(plan.diagram).toContain("n1 --> n2");
    expect(plan.diagram).toContain("n2 --> n3");
    expect(plan.diagram).toContain("n3 -->|yes| n4");
    expect(plan.diagram).toContain("n3 -->|no| n5");
    expect(plan.diagram).toContain("n4 --> n6");
    expect(plan.diagram).toContain("n5 --> n6");
    expect(parseDSL(plan.source)).toEqual(parseDSL(workflow));
    expect(plan).toEqual(createProgramPlan(workflow));
  });

  it("escapes model-authored labels instead of accepting Mermaid syntax or HTML", () => {
    const value =
      '"]\nclick n0 "javascript:alert(1)"\n%%{init: {securityLevel: "loose"}}%% <img src=x onerror=alert(1)> ```';
    const plan = createProgramPlan(`Eval("echo", ${JSON.stringify({ message: value })})`);
    expect(plan.diagram).not.toContain("\nclick");
    expect(plan.diagram).not.toContain("%%{");
    expect(plan.diagram).not.toContain("<img");
    expect(plan.diagram).not.toContain("```");
    expect(plan.diagram).toContain("#34;");
    expect(plan.steps[0]).toContain("javascript:alert(1)");
  });

  it("does not connect throwing branches to successful completion", () => {
    const plan = createProgramPlan('If(true,Throw("stop"),Eval("echo",{"message":"ok"}))');
    expect(plan.steps).toEqual(["true", 'Throw "stop"', 'Echo "ok"', "Program result"]);
    expect(plan.diagram).not.toContain("n1 --> n3");
    expect(plan.diagram).toContain("n2 --> n3");
    expect(createProgramPlan('Seq(Throw("stop"),Eval("echo",{}))').steps).toEqual(['Throw "stop"']);
  });

  it("shows a recursive function once and links calls back to it", () => {
    const source =
      'Let("loop",Fn(["acc"],Let("r",Eval("ask",{"message":"Next?"}),If(Eq(Get(Ref("r"),"action"),"accept"),Seq(Eval("echo",{"message":Ref("acc")}),Call(Ref("loop"),Ref("acc"))),Ref("acc")))),Call(Ref("loop"),""))';
    const plan = createProgramPlan(source);
    expect(plan.steps.filter((step) => step.startsWith("Function loop"))).toHaveLength(1);
    expect(plan.steps.filter((step) => step.startsWith("Ask "))).toHaveLength(1);
    expect(plan.steps).toContain("Return from loop");
    const functionId = `n${plan.steps.indexOf("Function loop(acc)")}`;
    expect(plan.diagram.split(`-. call .-> ${functionId}`).length - 1).toBe(2);
    expect(parseDSL(plan.source)).toEqual(parseDSL(source));
  });

  it("shows a while back edge and stop branch", () => {
    const plan = createProgramPlan('While(true,[Eval("echo",{"message":"again"})])');
    expect(plan.steps).toEqual(["While true", 'Echo "again"', "While result", "Program result"]);
    expect(plan.diagram).toContain("n1 --> n0");
    expect(plan.diagram).toContain("n0 -->|no| n2");
  });

  it("does not claim to resolve shadowed function names", () => {
    const plan = createProgramPlan('Let("f",Fn([],1),Let("f",Fn([],2),Call(Ref("f"))))');
    expect(plan.steps.filter((step) => step === "Function f()")).toHaveLength(2);
    expect(plan.diagram).not.toContain("-. call .->");
  });

  it("shows effects inside inline exchange callbacks", () => {
    const plan = createProgramPlan(
      'OnAccepted(Ask({"message":"Name?"}),Fn(["content","exchange"],Ask({"message":"Anything else?"})),Fn(["stop"],Ref("stop")))',
    );
    expect(plan.steps).toContain('Ask "Name?"');
    expect(plan.steps).toContain('Ask "Anything else?"');
    expect(plan.steps).toContain("Continue (content, exchange)");
  });

  it("renders larger plans and explicitly marks an omitted tail", () => {
    const complete = createProgramPlan(
      `Seq(${Array.from({ length: 65 }, () => 'Eval("echo",{})').join(",")})`,
    );
    expect(complete.truncated).toBe(false);
    expect(complete.steps).toHaveLength(66);
    const overview = createProgramPlan(
      `Seq(${Array.from({ length: 160 }, () => 'Eval("echo",{})').join(",")})`,
    );
    expect(overview.truncated).toBe(true);
    expect(overview.steps.at(-1)).toContain("omitted");
    expect(overview.steps).not.toContain("Program result");
    expect(overview.steps.length).toBeLessThan(125);
  });

  it.each([
    ["malformed DSL", "Let(", /Expected|Unexpected|end|argument/i],
    ["oversized input", " ".repeat(12_001), /12000 characters/],
    ["deep nesting", "[".repeat(49) + "]".repeat(49), /48 levels/],
  ])("rejects %s without producing a misleading partial diagram", (_name, source, error) => {
    expect(() => createProgramPlan(source)).toThrow(error);
  });
});
