import type { Model } from "@mariozechner/pi-ai";
import type { LoadExtensionsResult, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { SkillscAgentTool } from "../executor/agent-runtime-types.js";
import type { PiSubagentsToolExecutionContext } from "../executor/pi-subagents-runtime.js";
import {
	collectPiIntercomRegisteredTools,
	createPiIntercomAgentTool,
	tryCreatePiIntercomClientFromLoadedExtensions,
} from "../executor/pi-intercom-runtime.js";
import { createCliExtensionContext } from "./pi-subagents.js";

export const GRAPH_INTERCOM_BRIDGE_KEY = "__PI_WENDAO_PI_INTERCOM_BRIDGE__";

export interface CreateCliPiIntercomAgentToolOptions {
	loadResult: LoadExtensionsResult;
	modelRegistry: ModelRegistry;
	cwd: string;
	model?: Model<string>;
	signal?: AbortSignal;
	onUpdate?: unknown;
}

export interface PiWendaoGraphIntercomRequest {
	toolCallId: string;
	action: string;
	to: string;
	message: string;
	context?: PiSubagentsToolExecutionContext;
}

export interface PiWendaoGraphIntercomEvent {
	type: "intercom_call" | "intercom_send" | "intercom_reply" | "intercom_answer";
	toolCallId: string;
	action?: string;
	to?: string;
	message?: string;
	context?: PiSubagentsToolExecutionContext;
}

export interface PiWendaoGraphIntercomBridge {
	requestPlannerReply?: (request: PiWendaoGraphIntercomRequest, signal?: AbortSignal) => Promise<string>;
	onEvent?: (event: PiWendaoGraphIntercomEvent) => void;
}

declare global {
	// eslint-disable-next-line no-var
	var __PI_WENDAO_PI_INTERCOM_BRIDGE__: PiWendaoGraphIntercomBridge | undefined;
}

export function createCliPiIntercomAgentTool(
	options: CreateCliPiIntercomAgentToolOptions,
): SkillscAgentTool<any> | undefined {
	const ctx = createCliExtensionContext(options);
	const client = tryCreatePiIntercomClientFromLoadedExtensions(options.loadResult, {
		ctx,
		toolCallIdPrefix: "pi-wendao",
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
	});
	return client ? createPiIntercomAgentTool(client) : undefined;
}

export function hasLoadedPiIntercomTool(loadResult: LoadExtensionsResult): boolean {
	return collectPiIntercomRegisteredTools(loadResult).intercom !== undefined;
}

export function installGlobalPiIntercomBridge(bridge: PiWendaoGraphIntercomBridge | undefined): void {
	(globalThis as typeof globalThis & Record<string, PiWendaoGraphIntercomBridge | undefined>)[
		GRAPH_INTERCOM_BRIDGE_KEY
	] = bridge;
}
