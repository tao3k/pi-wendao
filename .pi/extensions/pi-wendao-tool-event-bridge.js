import { getCurrentPiSubagentsToolExecutionContext } from "../../dist/executor/pi-subagents-runtime.js";

const BRIDGE_KEY = "__PI_WENDAO_PI_SUBAGENTS_TOOL_EVENT_BRIDGE__";

export default function registerPiWendaoToolEventBridge(pi) {
	pi.on("tool_call", (event) => {
		const context = getCurrentPiSubagentsToolExecutionContext();
		const bridge = globalThis[BRIDGE_KEY];
		if (!context || !bridge?.onToolEvent) return;
		bridge.onToolEvent({
			type: "tool_call",
			...context,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
		});
	});

	pi.on("tool_result", (event) => {
		const context = getCurrentPiSubagentsToolExecutionContext();
		const bridge = globalThis[BRIDGE_KEY];
		if (!context || !bridge?.onToolEvent) return;
		bridge.onToolEvent({
			type: "tool_result",
			...context,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
			content: event.content,
			...(event.details === undefined ? {} : { details: event.details }),
			isError: event.isError === true,
		});
	});
}
