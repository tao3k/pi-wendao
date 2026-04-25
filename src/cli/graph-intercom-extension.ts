import { Type } from "typebox";
import { GRAPH_INTERCOM_BRIDGE_KEY } from "./pi-intercom.js";
import { getCurrentPiSubagentsToolExecutionContext } from "../executor/pi-subagents-runtime.js";

interface GraphIntercomExtensionApi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: unknown;
		executionMode?: string;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
		): Promise<GraphIntercomToolResult>;
	}): void;
}

interface GraphIntercomToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export default function registerPiWendaoPiIntercom(pi: GraphIntercomExtensionApi): void {
	pi.registerTool({
		name: "intercom",
		label: "Intercom",
		description: `Coordinate graph-local planner/worker handoffs in pi-wendao.

Use ask when a worker needs planner approval or clarification before continuing.
Use send for fire-and-forget progress reports.`,
		promptSnippet:
			"Use intercom({ action: \"ask\", to: \"planner\", message: \"...\" }) when you need graph-local planner approval before continuing.",
		parameters: Type.Object({
			action: Type.String({
				description: "Action: list, send, ask, reply, pending, or status",
			}),
			to: Type.Optional(Type.String({
				description: "Target session name. Use planner for graph-local approval.",
			})),
			message: Type.Optional(Type.String({
				description: "Message to send, ask, or reply with.",
			})),
			attachments: Type.Optional(Type.Array(Type.Object({
				type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
				name: Type.String(),
				content: Type.String(),
				language: Type.Optional(Type.String()),
			}))),
			replyTo: Type.Optional(Type.String({
				description: "Message id to reply to.",
			})),
		}),
		executionMode: "sequential",
		async execute(toolCallId, params, signal) {
			const action = normalizeAction(params.action);
			const target = normalizeTarget(params.to);
			const message = typeof params.message === "string" ? params.message.trim() : "";
			const bridge = globalThis[GRAPH_INTERCOM_BRIDGE_KEY];
			const context = getCurrentPiSubagentsToolExecutionContext();

			bridge?.onEvent?.({
				type: "intercom_call",
				toolCallId,
				action,
				to: target,
				message,
				context,
			});

			if (action === "status") {
				return textResult("pi-wendao graph intercom is connected.", { action, delivered: true, mode: "pi-wendao-graph" });
			}
			if (action === "list") {
				return textResult("Available graph-local sessions:\n- planner", { action, delivered: true, sessions: ["planner"] });
			}
			if (action === "pending") {
				return textResult("Pending graph-local asks are shown in the pi-wendao native chat stream.", { action, delivered: true });
			}
			if (action === "reply") {
				bridge?.onEvent?.({ type: "intercom_reply", toolCallId, to: target, message, context });
				return textResult(`Reply recorded for ${target || "planner"}.`, { action, delivered: true, to: target || "planner" });
			}
			if (action === "send") {
				bridge?.onEvent?.({ type: "intercom_send", toolCallId, to: target, message, context });
				return textResult(`Sent to ${target || "planner"}: ${message || "(empty message)"}`, {
					action,
					delivered: true,
					to: target || "planner",
				});
			}
			if (action === "ask") {
				if (!bridge?.requestPlannerReply) {
					return textResult("No pi-wendao graph planner inbox is available.", { action, delivered: false }, true);
				}
				if (target && target !== "planner") {
					return textResult(`pi-wendao graph intercom can ask planner, not ${target}.`, { action, delivered: false, to: target }, true);
				}
				const reply = await bridge.requestPlannerReply({
					toolCallId,
					action,
					to: "planner",
					message,
					context,
				}, signal);
				bridge?.onEvent?.({ type: "intercom_answer", toolCallId, to: "planner", message: reply, context });
				return textResult(`Planner replied:\n${reply}`, {
					action,
					delivered: true,
					to: "planner",
					reply,
				});
			}

			return textResult("intercom action must be list, send, ask, reply, pending, or status", { action, delivered: false }, true);
		},
	});
}

function normalizeAction(action: unknown): string {
	return typeof action === "string" ? action.trim().toLowerCase() : "";
}

function normalizeTarget(target: unknown): string {
	return typeof target === "string" ? target.trim().toLowerCase() : "";
}

function textResult(text: string, details: Record<string, unknown>, isError = false): GraphIntercomToolResult {
	return {
		content: [{ type: "text", text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}
