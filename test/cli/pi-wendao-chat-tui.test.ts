import { describe, expect, it } from "vitest";
import {
	classifyWorkflowChatLine,
	formatPiWendaoChatCommandOutput,
	loadPiWendaoChatSystemPrompt,
	parsePiWendaoChatCommand,
	PiWendaoChatView,
	WorkflowChatContextSession,
} from "../../src/cli/pi-wendao-chat-tui.js";
import { GraphView } from "../../src/output/graph-view.js";

describe("pi-wendao chat TUI commands", () => {
	it("treats normal text as LLM chat", () => {
		expect(parsePiWendaoChatCommand("hello workflow")).toEqual({
			kind: "chat",
			text: "hello workflow",
		});
	});

	it("parses workflow execution commands", () => {
		expect(parsePiWendaoChatCommand("/run /tmp/pi-wendao-real-llm-complex.bpmn")).toEqual({
			kind: "run",
			workflowPath: "/tmp/pi-wendao-real-llm-complex.bpmn",
		});
		expect(parsePiWendaoChatCommand('/open "fixtures/human approval.bpmn"')).toEqual({
			kind: "run",
			workflowPath: "fixtures/human approval.bpmn",
		});
	});

	it("parses qianji show commands", () => {
		expect(parsePiWendaoChatCommand("/show")).toEqual({ kind: "show" });
		expect(parsePiWendaoChatCommand("/show pi-wendao-instance test/fixtures/simple.bpmn")).toEqual({
			kind: "show",
			instanceId: "pi-wendao-instance",
			workflowPath: "test/fixtures/simple.bpmn",
		});
	});

	it("formats command output for chat transcript", () => {
		expect(formatPiWendaoChatCommandOutput({
			exitCode: 2,
			stdout: "instances\n",
			stderr: "warning\n",
		})).toBe("instances\nwarning\ncommand exited with code 2");
	});

	it("loads the chat system prompt from packaged .pi prompts", () => {
		const prompt = loadPiWendaoChatSystemPrompt();

		expect(prompt).toContain("pi-wendao TUI assistant");
		expect(prompt).toContain("compact running panel below the chat stream");
	});

	it("routes workflow lines into native chat roles", () => {
		expect(classifyWorkflowChatLine("subagent Task_5 12345678 completed")).toBe("agent");
		expect(classifyWorkflowChatLine("user")).toBe("user");
		expect(classifyWorkflowChatLine("assistant")).toBe("assistant");
		expect(classifyWorkflowChatLine("service task Task_1 executing")).toBe("tool");
		expect(classifyWorkflowChatLine("tool bash done")).toBe("tool");
		expect(classifyWorkflowChatLine("parallel jobs Task_Review: 2 jobs tokens=11,12")).toBe("tool");
		expect(classifyWorkflowChatLine("Workflow completed successfully.")).toBe("system");
		expect(classifyWorkflowChatLine("Error: failed")).toBe("error");
	});

	it("formats workflow run context for the chat session", () => {
		const context = new WorkflowChatContextSession();

		context.start("/tmp/pi-wendao-real-llm-complex.bpmn");
		context.record("tool", "parallel jobs Task_Review: 2 jobs tokens=11,12");
		context.record("assistant", "Branch A and Branch B finished.");
		context.finish(true);

		const content = context.toContextMessageContent();
		expect(content).toContain("[pi-wendao workflow context]");
		expect(content).toContain("workflowPath: /tmp/pi-wendao-real-llm-complex.bpmn");
		expect(content).toContain("status: completed");
		expect(content).toContain("tool> parallel jobs Task_Review: 2 jobs tokens=11,12");
		expect(content).toContain("assistant> Branch A and Branch B finished.");
	});

	it("persists workflow context as a hidden pi custom message", async () => {
		const context = new WorkflowChatContextSession();
		const sent: Array<{ message: unknown; options: unknown }> = [];

		context.start("/tmp/workflow.bpmn");
		context.record("tool", "qianji: service task Task_1 completed");
		context.finish(true);
		await context.persistToSession({
			sendCustomMessage: async (message, options) => {
				sent.push({ message, options });
			},
		} as never);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toMatchObject({
			customType: "pi_wendao_workflow_context",
			display: false,
			details: {
				workflowPath: "/tmp/workflow.bpmn",
				status: "completed",
			},
		});
		expect(sent[0]?.message).toMatchObject({
			content: expect.stringContaining("tool> qianji: service task Task_1 completed"),
		});
		expect(sent[0]?.options).toBeUndefined();
	});

	it("renders workflow graph below the native chat stream on wide terminals", () => {
		const graphView = new GraphView();
		const view = new PiWendaoChatView(
			{ rows: 18 } as never,
			{
				render: () => ["> "],
				invalidate: () => {},
			} as never,
			"/repo",
			graphView,
		);

		view.openWorkflow("/tmp/pi-wendao-real-llm-complex.bpmn");
		graphView.addNode({ id: "Task_1", label: "Run task", type: "task", status: "active" });
		view.append("system", "workflow event");

		const plain = view.render(140).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

		expect(plain.indexOf("pi-wendao LLM chat")).toBeLessThan(plain.indexOf("workflow event"));
		expect(plain.indexOf("workflow event")).toBeLessThan(plain.indexOf("workflow graph"));
		expect(plain).not.toContain("|");
	});

	it("keeps workflow context bounded for large event streams", () => {
		const context = new WorkflowChatContextSession();

		context.start("/tmp/large.bpmn");
		for (let i = 0; i < 120; i += 1) {
			context.record("tool", `event ${i} ${"x".repeat(500)}`);
		}
		context.record("assistant", Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));

		const content = context.toContextMessageContent();
		expect(content.length).toBeLessThanOrEqual(6_000);
		expect(content).toContain("omittedEvents:");
		expect(content).toContain("... 13 lines omitted from this event ...");
		expect(content).toContain("line 19");
		expect(content).not.toContain("event 0");
		expect(content).not.toContain("\u001b[");
	});
});
