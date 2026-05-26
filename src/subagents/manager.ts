import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  NativeSubagentGetResultRequest,
  NativeSubagentRecord,
  NativeSubagentSpawnRequest,
  NativeSubagentSteerRequest,
  NativeSubagentToolResult,
} from "./protocol.js";
import { textResult } from "./protocol.js";
import { runNativeSubagent } from "./runner.js";

export class NativeSubagentManager {
  private readonly records = new Map<string, NativeSubagentRecord>();

  async spawn(
    request: NativeSubagentSpawnRequest,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
  ): Promise<NativeSubagentToolResult> {
    if (request.resume) {
      return this.resume(request.resume, request.prompt, signal);
    }

    const record = this.createRecord(request);
    this.records.set(record.id, record);
    const run = this.runRecord(record, ctx, signal, onUpdate);
    record.promise = run;

    if (request.run_in_background === false) {
      await run;
      return this.renderRecord(record, { verbose: false });
    }

    return textResult(
      `Agent started in background.\nAgent ID: ${record.id}\nType: ${record.type}\nDescription: ${record.description}\n\nUse get_subagent_result to retrieve the result.`,
      {
        agentId: record.id,
        status: "background",
        description: record.description,
        subagentType: record.type,
        toolUses: 0,
        maxTurns: record.maxTurns,
        modelName: record.modelName,
        durationMs: 0,
      },
    );
  }

  async getResult(
    request: NativeSubagentGetResultRequest,
    signal: AbortSignal | undefined,
  ): Promise<NativeSubagentToolResult> {
    const record = this.records.get(request.agent_id);
    if (!record) {
      return textResult(`Agent not found: "${request.agent_id}". It may have been cleaned up.`, {
        agentId: request.agent_id,
        status: "failed",
        error: "not found",
      });
    }
    if (request.wait && record.promise && isActiveStatus(record.status)) {
      await interruptible(record.promise, signal);
    }
    return this.renderRecord(record, { verbose: request.verbose === true });
  }

  async steer(
    request: NativeSubagentSteerRequest,
    signal: AbortSignal | undefined,
  ): Promise<NativeSubagentToolResult> {
    const record = this.records.get(request.agent_id);
    if (!record) {
      return textResult(`Agent not found: "${request.agent_id}". It may have been cleaned up.`, {
        agentId: request.agent_id,
        status: "failed",
        error: "not found",
      });
    }
    if (!record.session || record.status !== "running") {
      return textResult(`Agent "${record.id}" is not running (status: ${record.status}).`, {
        agentId: record.id,
        status: record.status,
      });
    }
    await interruptible(record.session.steer(request.message), signal);
    return textResult(`Steering message sent to agent ${record.id}.`, {
      agentId: record.id,
      status: record.status,
      description: record.description,
      subagentType: record.type,
    });
  }

  private createRecord(request: NativeSubagentSpawnRequest): NativeSubagentRecord {
    const id = randomUUID().slice(0, 17);
    return {
      id,
      description: request.description,
      type: normalizeSubagentType(request.subagent_type),
      prompt: request.prompt,
      status: "running",
      startedAt: Date.now(),
      toolUses: 0,
      turnCount: 0,
      ...(request.max_turns ? { maxTurns: request.max_turns } : {}),
      ...(request.model ? { modelName: request.model } : {}),
      invocation: {
        ...(request.model ? { modelName: request.model } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.max_turns ? { maxTurns: request.max_turns } : {}),
        ...(request.isolated === undefined ? {} : { isolated: request.isolated }),
        ...(request.inherit_context === undefined ? {} : { inheritContext: request.inherit_context }),
        runInBackground: request.run_in_background !== false,
      },
      abortController: new AbortController(),
    };
  }

  private async runRecord(
    record: NativeSubagentRecord,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
  ): Promise<string> {
    const childSignal = combineSignals(signal, record.abortController.signal);
    try {
      const result = await runNativeSubagent(
        {
          type: record.type,
          prompt: record.prompt,
          description: record.description,
          cwd: ctx.cwd,
          modelName: record.modelName,
          thinking: record.invocation.thinking,
          maxTurns: record.maxTurns,
          isolated: record.invocation.isolated,
          inheritContext: record.invocation.inheritContext,
        },
        {
          ctx,
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          signal: childSignal,
          onSessionCreated: (session) => {
            record.session = session;
          },
          onTurnEnd: (turnCount) => {
            record.turnCount = turnCount;
            this.emitUpdate(record, onUpdate);
          },
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses += 1;
            this.emitUpdate(record, onUpdate, activity.toolName);
          },
        },
      );
      record.result = result.responseText;
      record.session = result.session;
      record.status = "completed";
      record.completedAt = Date.now();
      return result.responseText;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      record.error = error.message;
      record.status = record.abortController.signal.aborted ? "stopped" : "failed";
      record.completedAt = Date.now();
      return "";
    }
  }

  private emitUpdate(
    record: NativeSubagentRecord,
    onUpdate: unknown,
    toolName?: string,
  ): void {
    if (typeof onUpdate !== "function") return;
    onUpdate({
      content: [{ type: "text", text: `subagent ${record.id} running` }],
      details: {
        agentId: record.id,
        status: "running",
        description: record.description,
        subagentType: record.type,
        toolUses: record.toolUses,
        turnCount: record.turnCount,
        maxTurns: record.maxTurns,
        activity: toolName ? `running ${toolName}` : "thinking",
      },
    });
  }

  private async resume(
    agentId: string,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<NativeSubagentToolResult> {
    const record = this.records.get(agentId);
    if (!record?.session) {
      return textResult(`Agent "${agentId}" has no active session to resume.`, {
        agentId,
        status: "failed",
        error: "no active session",
      });
    }
    record.status = "running";
    try {
      await interruptible(record.session.sendUserMessage(prompt), signal);
      record.result = `${record.result ?? ""}\n\n${prompt}`.trim();
      record.status = "completed";
      record.completedAt = Date.now();
      return this.renderRecord(record, { verbose: false });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      record.error = error.message;
      record.status = "failed";
      record.completedAt = Date.now();
      return this.renderRecord(record, { verbose: false });
    }
  }

  private renderRecord(
    record: NativeSubagentRecord,
    options: { verbose: boolean },
  ): NativeSubagentToolResult {
    const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
    const details = {
      agentId: record.id,
      status: record.status,
      description: record.description,
      subagentType: record.type,
      toolUses: record.toolUses,
      turnCount: record.turnCount,
      maxTurns: record.maxTurns,
      modelName: record.modelName,
      durationMs,
      ...(record.error ? { error: record.error } : {}),
    };
    if (record.status === "running" || record.status === "queued") {
      return textResult(
        `Agent: ${record.id}\nType: ${record.type} | Status: ${record.status}\nDescription: ${record.description}\n\nAgent is still running. Use wait: true or check back later.`,
        details,
      );
    }
    if (record.status === "failed" || record.status === "stopped") {
      return textResult(
        `Agent: ${record.id}\nType: ${record.type} | Status: ${record.status}\nDescription: ${record.description}\n\nError: ${record.error ?? record.status}`,
        details,
        true,
      );
    }
    const conversation = options.verbose && record.session ? renderConversation(record.session) : "";
    return textResult(`${record.result?.trim() || "No output."}${conversation}`, details);
  }
}

function normalizeSubagentType(value: string): string {
  const normalized = value.trim();
  return normalized || "general-purpose";
}

function isActiveStatus(status: NativeSubagentRecord["status"]): boolean {
  return status === "queued" || status === "running";
}

function interruptible<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Subagent wait interrupted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("Subagent wait interrupted")), {
        once: true,
      });
    }),
  ]);
}

function combineSignals(
  parent: AbortSignal | undefined,
  child: AbortSignal,
): AbortSignal | undefined {
  if (!parent) return child;
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  child.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function renderConversation(session: import("@earendil-works/pi-coding-agent").AgentSession): string {
  const lines: string[] = [];
  for (const message of session.messages) {
    if (message.role === "user") {
      lines.push(`[User]: ${messageContentToText(message.content)}`);
    } else if (message.role === "assistant") {
      lines.push(`[Assistant]: ${messageContentToText(message.content)}`);
    }
  }
  return lines.length > 0 ? `\n\n--- Agent Conversation ---\n${lines.join("\n\n")}` : "";
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}
