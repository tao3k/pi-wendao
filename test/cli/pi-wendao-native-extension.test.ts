import { describe, expect, it } from "vitest";
import { parseNativeRunCommand, parseNativeShowCommand } from "../../src/cli/pi-wendao-native-extension.js";
import { buildPiWendaoNativeArgs } from "../../src/cli/pi-wendao-native-launcher.js";

describe("pi-wendao native pi extension", () => {
	it("parses /run workflow arguments with qianji execution options", () => {
		expect(parseNativeRunCommand("/tmp/workflow.bpmn --instance-id pi-wendao-complex --dmn decision.dmn --var topic=test --no-graph")).toMatchObject({
			workflowPath: "/tmp/workflow.bpmn",
			instanceId: "pi-wendao-complex",
			dmnPaths: ["decision.dmn"],
			variables: ["topic=test"],
			graph: false,
		});
	});

	it("supports quoted /run paths", () => {
		expect(parseNativeRunCommand('"fixtures/human approval.bpmn" --trace-frame-ms 5').workflowPath).toBe(
			"fixtures/human approval.bpmn",
		);
		expect(parseNativeRunCommand('"fixtures/human approval.bpmn" --trace-frame-ms 5').traceFrameMs).toBe(5);
	});

	it("parses /show instance and workflow arguments", () => {
		expect(parseNativeShowCommand("pi-wendao-complex test/fixtures/simple-workflow.bpmn --dmn decision.dmn")).toEqual({
			instanceId: "pi-wendao-complex",
			workflowPath: "test/fixtures/simple-workflow.bpmn",
			dmnPaths: ["decision.dmn"],
		});
	});

	it("launches pi native TUI with bundled pi-subagents and user extensions", () => {
		const args = buildPiWendaoNativeArgs({
			modelPattern: "anthropic/claude-sonnet-4-20250514",
			thinkingLevel: "medium",
			invocationCwd: "/repo",
			piContextCwd: "/repo/.data/skillsc",
			resolvedExtensionPaths: ["/tmp/custom-extension.js"],
			baseWorkflowOptions: {},
			resolvedDmnPaths: [],
		});

		expect(args).toContain("--continue");
		expect(args).toContain("--model");
		expect(args).toContain("anthropic/claude-sonnet-4-20250514");
		expect(args).toContain("--thinking");
		expect(args).toContain("medium");
		expect(args).toContain("/tmp/custom-extension.js");
		expect(args.some((arg) => arg.includes("@tintinweb/pi-subagents"))).toBe(true);
	});
});
