import type { Message } from "@mariozechner/pi-ai";
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
		expect(prompt).toContain("top workflow graph panel");
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

	it("stores workflow run context in the chat message history", () => {
		const messages: Message[] = [];
		const context = new WorkflowChatContextSession(messages);

		context.start("/tmp/pi-wendao-real-llm-complex.bpmn");
		context.record("tool", "parallel jobs Task_Review: 2 jobs tokens=11,12");
		context.record("assistant", "Branch A and Branch B finished.");
		context.finish(true);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ role: "user" });
		expect(messages[0]?.content).toContain("[pi-wendao workflow context]");
		expect(messages[0]?.content).toContain("workflowPath: /tmp/pi-wendao-real-llm-complex.bpmn");
		expect(messages[0]?.content).toContain("status: completed");
		expect(messages[0]?.content).toContain("tool> parallel jobs Task_Review: 2 jobs tokens=11,12");
		expect(messages[0]?.content).toContain("assistant> Branch A and Branch B finished.");
	});

	it("renders workflow graph above chat on wide terminals", () => {
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

		expect(plain.indexOf("workflow graph")).toBeLessThan(plain.indexOf("pi-wendao LLM chat"));
		expect(plain).not.toContain("|");
	});

	it("keeps workflow context bounded for large event streams", () => {
		const messages: Message[] = [];
		const context = new WorkflowChatContextSession(messages);

		context.start("/tmp/large.bpmn");
		for (let i = 0; i < 120; i += 1) {
			context.record("tool", `event ${i} ${"x".repeat(500)}`);
		}
		context.record("assistant", Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));

		const content = messages[0]?.content;
		expect(typeof content).toBe("string");
		expect(content.length).toBeLessThanOrEqual(6_000);
		expect(content).toContain("omittedEvents:");
		expect(content).toContain("... 13 lines omitted from this event ...");
		expect(content).toContain("line 19");
		expect(content).not.toContain("event 0");
		expect(content).not.toContain("\u001b[");
	});
});
