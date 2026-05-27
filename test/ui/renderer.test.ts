import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../src/ui/ansi.js";
import {
  formatArgsForLog,
  formatAssistantMessageForLog,
  formatPiSubagentsHostEventForLog,
  formatPiSubagentsHostToolEventForGraphDetail,
  formatPiSubagentsHostToolEventForLog,
  formatPiSubagentsToolUpdateForGraphDetail,
  formatPiSubagentsToolUpdateForLog,
  formatQianjiCliOutputForLog,
  formatQianjiHostWorkEventForLog,
  formatThinkingMessageForLog,
  formatToolResultForLog,
  formatVariableValueForLog,
  waitForTerminalKey,
} from "../../src/ui/renderer.js";

class FakeKeyInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  resumeCount = 0;
  pauseCount = 0;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }

  resume(): this {
    this.resumeCount += 1;
    return this;
  }

  pause(): this {
    this.pauseCount += 1;
    return this;
  }
}

describe("renderer event formatting", () => {
  it("waits for one TTY key and restores raw mode", async () => {
    const input = new FakeKeyInput();
    const done = waitForTerminalKey(input as unknown as NodeJS.ReadStream);
    let resolved = false;
    done.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    input.emit("data", Buffer.from("x"));
    await done;

    expect(input.rawModes).toEqual([true, false]);
    expect(input.resumeCount).toBe(1);
    expect(input.pauseCount).toBe(1);
  });

  it("does not block when key input is not a TTY", async () => {
    const input = new FakeKeyInput();
    input.isTTY = false;

    await expect(
      waitForTerminalKey(input as unknown as NodeJS.ReadStream),
    ).resolves.toBeUndefined();
    expect(input.rawModes).toEqual([]);
    expect(input.resumeCount).toBe(0);
  });

  it("summarizes assistant JSON blocks instead of printing raw payloads", () => {
    const lines = formatAssistantMessageForLog(
      '```json\n{"fileList":"a.ts\\nb.ts\\nc.ts"}\n```',
    ).map(stripAnsi);

    expect(lines).toEqual(["assistant", "  output", "    fileList: 3 lines"]);
    expect(lines.join("\n")).not.toContain("```");
    expect(lines.join("\n")).not.toContain("a.ts\\nb.ts");
  });

  it("keeps assistant message hierarchy", () => {
    const lines = formatAssistantMessageForLog("Plan:\n- list files\n- count files").map(stripAnsi);

    expect(lines).toEqual(["assistant", "  Plan:", "  - list files", "  - count files"]);
  });

  it("formats thinking as an indented dialogue block", () => {
    const lines = formatThinkingMessageForLog("Need files first.\nThen count them.").map(stripAnsi);

    expect(lines).toEqual(["  Need files first.", "  Then count them."]);
  });

  it("formats bash calls without bracketed function syntax", () => {
    expect(formatArgsForLog({ command: 'find . -name "*.ts"' })).toBe('"find . -name \\"*.ts\\""');
  });

  it("summarizes multiline tool output", () => {
    const lines = formatToolResultForLog(
      "bash",
      {
        content: [{ type: "text", text: "a.ts\nb.ts\nc.ts\n" }],
        details: {},
      },
      false,
    ).map(stripAnsi);

    expect(lines).toEqual(["tool bash done", "  result: 3 lines"]);
  });

  it("summarizes qianji markdown reports with checkpoint recovery state", () => {
    const lines = formatQianjiCliOutputForLog(
      [
        '@@QIANJI_TRACE {"kind":"node_status"}',
        "# BPMN Run",
        "Outcome: blocked_on_host",
        "Checkpoint backend: sqlite",
        "Checkpoint source: fresh",
        "Checkpoint saved: yes",
        "Checkpoint deleted: no",
        "Pending host work: 1",
        "## Variables",
        "```json",
        '{"large":"payload"}',
        "```",
        "# BPMN Task Complete",
        "Outcome: completed",
        "Checkpoint backend: sqlite",
        "Checkpoint source: resumed",
        "Checkpoint saved: yes",
        "Checkpoint deleted: no",
        "Pending host work: 0",
      ].join("\n"),
    ).map(stripAnsi);

    expect(lines).toEqual([
      "qianji run: blocked_on_host (checkpoint=sqlite, source=fresh, saved=yes, deleted=no, pending_host=1)",
      "qianji task complete: completed (checkpoint=sqlite, source=resumed, saved=yes, deleted=no)",
    ]);
  });

  it("summarizes qianji control recovery reports with multiple actions", () => {
    const lines = formatQianjiCliOutputForLog(
      [
        "# BPMN Control Recovery",
        "Outcome: reported",
        "Activities: total 2, failed 2, in-flight 0",
        "Recovery actions: total 2, retry 1, review 1, terminal 0",
        "Action: retry_activity Task_A",
        "Action: review_retryable_activity Task_B",
      ].join("\n"),
    ).map(stripAnsi);

    expect(lines).toEqual([
      "qianji control recovery: reported (activities=total 2, failed 2, in-flight 0, recovery=total 2, retry 1, review 1, terminal 0, actions=2 retry_activity Task_A; review_retryable_activity Task_B)",
    ]);
  });

  it("formats qianji host work batches as explicit parallel job evidence", () => {
    const lines = formatQianjiHostWorkEventForLog({
      activityId: "Task_Review",
      hostWorkCount: 2,
      batchHostWorkCount: 2,
      tokenIds: [11, 12],
      hostKinds: ["service"],
      parallel: true,
      repeatKinds: ["parallel_multi_instance"],
      repeatSummaries: ["parallel_multi_instance 1/2", "parallel_multi_instance 2/2"],
    }).map(stripAnsi);

    expect(lines).toEqual([
      "parallel jobs Task_Review: 2 jobs tokens=11,12 kind=service repeat=parallel_multi_instance 1/2;parallel_multi_instance 2/2",
    ]);
  });

  it("formats qianji human-task assignment metadata as routing evidence", () => {
    const lines = formatQianjiHostWorkEventForLog({
      activityId: "Task_RustApprove",
      hostWorkCount: 1,
      batchHostWorkCount: 1,
      tokenIds: [91],
      hostKinds: ["user"],
      parallel: false,
      repeatKinds: [],
      repeatSummaries: [],
      assignmentSummaries: [
        "human_performer:reviewer:expr=users.alice;potential_owner:review_team:ref=reviewers",
      ],
    }).map(stripAnsi);

    expect(lines).toEqual([
      "host job Task_RustApprove: 1 job token=91 kind=user assignment=human_performer:reviewer:expr=users.alice;potential_owner:review_team:ref=reviewers",
    ]);
  });

  it("formats verbose pi-subagents conversations for the native chat stream", () => {
    const lines = formatPiSubagentsHostEventForLog({
      type: "result",
      activityId: "Task_5",
      agentId: "12345678-90ab",
      description: "Branch A",
      resultText: [
        "Agent: 12345678-90ab",
        "Type: Worker | Status: completed | Tool uses: 1 | Duration: 2s",
        "Description: Branch A",
        "",
        "Done.",
        '```json\n{"resultA":"alpha"}\n```',
        "",
        "--- Agent Conversation ---",
        "[User]: Execute.",
        "",
        "[Assistant]: I will run the branch.",
        "",
        "[Tool Calls]:",
        "  Tool: bash",
        "",
        "[Tool Result (bash)]: ok",
        "",
        '[Assistant]: ```json\n{"resultA":"alpha"}\n```',
      ].join("\n"),
    }).map(stripAnsi);

    expect(lines).toContain("subagent Task_5 12345678 completed");
    expect(lines).toContain("user");
    expect(lines).toContain("  Execute.");
    expect(lines).toContain("assistant");
    expect(lines).toContain("  I will run the branch.");
    expect(lines).toContain("tool bash");
    expect(lines).toContain("tool bash done");
    expect(lines).toContain("  output");
    expect(lines).toContain("    resultA: alpha");
  });

  it("formats pi-subagents live updates without raw widget payloads", () => {
    const lines = formatPiSubagentsToolUpdateForLog({
      content: [{ type: "text", text: "1 tool uses..." }],
      details: {
        activity: "running bash",
        toolUses: 1,
        turnCount: 2,
        maxTurns: 8,
        tokens: "12k token",
      },
    }).map(stripAnsi);

    expect(lines).toEqual(["subagent running bash (1 tool, turn 2/8, 12k token)"]);
  });

  it("formats activity-scoped pi-subagents tool calls with arguments", () => {
    const call = {
      type: "tool_call" as const,
      activityId: "Task_A",
      description: "Run A",
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: 'find . -name "*.ts"' },
    };
    const lines = formatPiSubagentsHostToolEventForLog(call).map(stripAnsi);

    expect(lines).toEqual([
      "subagent Task_A",
      "  tool bash",
      '    command: "find . -name \\"*.ts\\""',
    ]);
    expect(formatPiSubagentsHostToolEventForGraphDetail(call)).toBe(
      'tool:bash "find . -name \\"*.ts\\""',
    );
    expect(
      formatPiSubagentsHostToolEventForLog({
        ...call,
        type: "tool_result",
        content: [{ type: "text", text: "a.ts\nb.ts\n" }],
        isError: false,
      }).map(stripAnsi),
    ).toEqual(["subagent Task_A", "  tool bash done", "    result: 2 lines"]);

    const intercomCall = {
      ...call,
      toolName: "intercom",
      toolCallId: "tool-2",
      input: { action: "status" },
    };
    expect(formatPiSubagentsHostToolEventForLog(intercomCall).map(stripAnsi)).toEqual([
      "subagent Task_A",
      "  tool intercom",
      "    args: action=status",
    ]);
    expect(formatPiSubagentsHostToolEventForGraphDetail(intercomCall)).toBe(
      "tool:intercom action=status",
    );
  });

  it("formats activity-scoped pi-subagents live updates for graph nodes", () => {
    const update = {
      content: [{ type: "text", text: "1 tool uses..." }],
      details: {
        activity: "running bash",
        toolUses: 1,
        turnCount: 2,
        maxTurns: 8,
      },
    };
    const lines = formatPiSubagentsToolUpdateForLog(update, { activityId: "Task_A" }).map(
      stripAnsi,
    );

    expect(lines).toEqual(["subagent Task_A running bash (1 tool, turn 2/8)"]);
    expect(formatPiSubagentsToolUpdateForGraphDetail(update)).toBe("llm:bash t2/8 1t");
  });

  it("normalizes pi-subagents response text fragments in live updates", () => {
    const update = {
      details: {
        activity: "```json",
        toolUses: 1,
        turnCount: 1,
      },
    };

    expect(
      formatPiSubagentsToolUpdateForLog(update, { activityId: "Task_A" }).map(stripAnsi),
    ).toEqual(["subagent Task_A responding (1 tool, turn 1)"]);
    expect(formatPiSubagentsToolUpdateForGraphDetail(update)).toBe("llm:responding t1 1t");
  });

  it("summarizes large variable values", () => {
    expect(formatVariableValueForLog("a.ts\nb.ts\nc.ts")).toBe("3 lines");
    expect(formatVariableValueForLog(["a", "b"])).toBe("2 items");
  });
});
