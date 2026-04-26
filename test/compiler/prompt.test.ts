import { describe, expect, it } from "vitest";
import { buildCompilePrompt, buildTargetDecisionPrompt } from "../../src/compiler/prompt.js";

const templates = {
  bpmn: '<definitions><process id="Process_1" /></definitions>',
  dmn: '<definitions><decision id="skill-decision" /></definitions>',
};

describe("buildCompilePrompt", () => {
  it("returns system prompt and user message", () => {
    const { systemPrompt, userMessage } = buildCompilePrompt(
      undefined,
      "# My Skill\nDo stuff",
      templates,
    );

    expect(systemPrompt).toContain("BPMN");
    expect(systemPrompt).toContain("serviceTask");
    expect(systemPrompt).toContain("qianji:config");
    expect(systemPrompt).toContain("environment.services.runAgent");
    expect(userMessage).toContain("Qianji BPMN template");
    expect(userMessage).toContain("Selected qianji construct cards");
    expect(userMessage).toContain("Raw SKILL.md");
    expect(userMessage).toContain("Process_1");
    expect(userMessage).toContain("Do stuff");
  });

  it("system prompt describes the extension element format", () => {
    const { systemPrompt } = buildCompilePrompt();

    expect(systemPrompt).toContain("qianji:prompt");
    expect(systemPrompt).toContain("qianji:tools");
    expect(systemPrompt).toContain("qianji:inputs");
    expect(systemPrompt).toContain("qianji:outputs");
    expect(systemPrompt).toContain("qianji:interaction");
  });

  it("system prompt models graph-local human gates as BPMN userTask", () => {
    const { systemPrompt } = buildCompilePrompt();

    expect(systemPrompt).toContain("userTask");
    expect(systemPrompt).toContain("user-task.interaction");
    expect(systemPrompt).toContain("dynamic choices");
    expect(systemPrompt).toContain("construct card");
  });

  it("system prompt delegates card-owned interaction schema instead of embedding the full scaffold", () => {
    const { systemPrompt } = buildCompilePrompt();

    expect(systemPrompt).toContain("user-task.interaction");
    expect(systemPrompt).toContain("qianji lint diagnose contract drift");
    expect(systemPrompt).not.toContain('<qianji:choices ref="currentChoices"/>');
    expect(systemPrompt).not.toContain('<qianji:choice value="approved"');
    expect(systemPrompt).not.toContain("approvedReply");
  });

  it("system prompt describes condition expression format", () => {
    const { systemPrompt } = buildCompilePrompt();

    expect(systemPrompt).toContain("conditionExpression");
    expect(systemPrompt).toContain("gateway.exclusive.bounded");
    expect(systemPrompt).toContain("qianji lint reports a gateway issue");
    expect(systemPrompt).toContain("compact diagnostic");
    expect(systemPrompt).toContain("structured repair plan");
  });

  it("system prompt describes qianji-compatible fallback handling", () => {
    const { systemPrompt } = buildCompilePrompt();

    expect(systemPrompt).toContain("Fallback Handling");
    expect(systemPrompt).toContain("Do NOT generate task-level `boundaryEvent`");
    expect(systemPrompt).toContain("exclusiveGateway");
  });

  it("system prompt describes qianji-native bounded repeat execution", () => {
    const { systemPrompt } = buildCompilePrompt();

    expect(systemPrompt).toContain("Qianji-Native Repeat Execution");
    expect(systemPrompt).toContain("Use repeat metadata");
    expect(systemPrompt).toContain("qianji lint is the authority");
    expect(systemPrompt).toContain("exact");
  });

  it("system prompt keeps qianji as the orchestration owner", () => {
    const { systemPrompt } = buildCompilePrompt();

    expect(systemPrompt).toContain("Architecture Ownership");
    expect(systemPrompt).toContain("Qianji owns");
    expect(systemPrompt).toContain("checkpoint persistence");
    expect(systemPrompt).toContain("serviceTask prompt describes only");
    expect(systemPrompt).toContain("Do not rely on a Markdown parser");
    expect(systemPrompt).toContain("Infer the workflow or");
  });

  it("builds a target decision prompt for BPMN vs BPMN+DMN", () => {
    const { systemPrompt, userMessage } = buildTargetDecisionPrompt(
      "# My Skill\nUse a policy table.",
      "# Qianji Construct Index",
    );

    expect(systemPrompt).toContain('"bpmn"');
    expect(systemPrompt).toContain('"bpmn-dmn"');
    expect(systemPrompt).toContain("selectedConstructs");
    expect(systemPrompt).toContain("interactive");
    expect(systemPrompt).toContain("Pure DMN is not an executable workflow");
    expect(systemPrompt).toContain("no Markdown semantic parser");
    expect(userMessage).toContain("qianji compile artifact target");
    expect(userMessage).toContain("Qianji construct index");
    expect(userMessage).toContain("Raw SKILL.md");
    expect(userMessage).toContain("Use a policy table");
  });

  it("compile prompt carries the selected target decision", () => {
    const { systemPrompt, userMessage } = buildCompilePrompt(
      {
        target: "bpmn-dmn",
        reason: "stable table",
        dmnDecisions: ["eligibility-decision"],
      },
      "# Skill\nUse table",
      templates,
    );

    expect(systemPrompt).toContain("businessRuleTask");
    expect(systemPrompt).toContain("DMN only for tables");
    expect(userMessage).toContain('"target": "bpmn-dmn"');
    expect(userMessage).toContain("eligibility-decision");
    expect(userMessage).toContain("Qianji DMN template");
  });
});
