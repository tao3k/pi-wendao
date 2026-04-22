import { EventEmitter } from "node:events";
import { Engine } from "bpmn-engine";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { GraphView } from "../output/graph-view.js";
import { createRunAgentService, type SkillscConfig } from "./node-runner.js";

export interface ExecuteOptions {
	/** BPMN 2.0 XML source */
	source: string;
	/** Model for task execution */
	model: Model<string>;
	/** API key */
	apiKey?: string;
	/** Working directory */
	cwd?: string;
	/** Initial variables as key=value pairs */
	variables?: string[];
	/** Called for each pi-agent-core event during task execution */
	onAgentEvent?: (event: AgentEvent) => void;
	/** Called when a BPMN activity starts */
	onActivityStart?: (activityId: string, activityName: string) => void;
	/** Called when a BPMN activity ends */
	onActivityEnd?: (activityId: string, activityName: string) => void;
	/** Called when a flow is taken */
	onFlowTake?: (flowId: string) => void;
	/** Called on error */
	onError?: (err: Error) => void;
	/** Custom moddle options for bpmn-engine (e.g., extension namespaces) */
	moddleOptions?: Record<string, unknown>;
	/** If provided, the executor populates and updates this graph view during execution */
	graphView?: GraphView;
	/** Called after graph is populated but before execution starts */
	onGraphReady?: () => void;
	/** Called when graph state changes (node status, edge taken) */
	onGraphUpdate?: () => void;
}

export interface ExecuteResult {
	success: boolean;
	error?: string;
	variables: Record<string, unknown>;
	output: Record<string, unknown>;
}

/**
 * Extract skillsc config from a bpmn-moddle activity behaviour.
 * bpmn-moddle parses extension elements into behaviour.extensionElements.values[]
 */
function extractSkillscConfig(behaviour: Record<string, unknown>): SkillscConfig | undefined {
	const extensionElements = behaviour.extensionElements as { values?: Array<Record<string, unknown>> } | undefined;
	if (!extensionElements?.values) return undefined;

	for (const ext of extensionElements.values) {
		const type = (ext.$type ?? "") as string;
		if (type !== "skillsc:config") continue;

		// bpmn-moddle parses nested extension elements as $children
		const children = (ext.$children ?? []) as Array<{ $type?: string; $body?: string }>;
		const childMap = new Map<string, string>();
		for (const child of children) {
			if (child.$type) {
				childMap.set(child.$type, child.$body ?? "");
			}
		}

		return {
			prompt: childMap.get("skillsc:prompt") ?? "",
			tools: csv(childMap.get("skillsc:tools") ?? ""),
			inputs: csv(childMap.get("skillsc:inputs") ?? ""),
			outputs: csv(childMap.get("skillsc:outputs") ?? ""),
		};
	}
	return undefined;
}

function csv(value: string): string[] {
	if (!value.trim()) return [];
	return value.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Execute a BPMN 2.0 workflow using bpmn-engine, with service tasks
 * delegated to pi-agent-core Agent instances.
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
	const {
		source,
		model,
		apiKey,
		cwd,
		onAgentEvent,
		onActivityStart,
		onActivityEnd,
		onFlowTake,
		onError,
	} = options;

	// Parse initial variables from CLI pairs
	const initialVariables: Record<string, unknown> = {};
	if (options.variables) {
		for (const pair of options.variables) {
			const idx = pair.indexOf("=");
			if (idx === -1) continue;
			initialVariables[pair.slice(0, idx)] = pair.slice(idx + 1);
		}
	}

	// Map of activity ID -> skillsc config, populated by the extension
	const activityConfigs = new Map<string, SkillscConfig>();

	// Create the runAgent service function
	const runAgent = createRunAgentService({
		model,
		apiKey,
		cwd,
		onEvent: onAgentEvent,
		getConfig: (activityId: string) => activityConfigs.get(activityId),
	});

	// bpmn-engine extension that extracts skillsc:config from extension elements
	// and stores them in activityConfigs for the service function to use
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function skillscExtension(activity: any) {
		const behaviour = (activity.behaviour ?? {}) as Record<string, unknown>;
		const id = activity.id as string;
		const config = extractSkillscConfig(behaviour);
		if (config) {
			activityConfigs.set(id, config);
		}
	}

	// Set up bpmn-engine listener for lifecycle events
	const listener = new EventEmitter();

	listener.on("activity.start", (elementApi: { id: string; name?: string }) => {
		if (options.graphView) {
			options.graphView.setNodeStatus(elementApi.id, "active");
			options.onGraphUpdate?.();
		}
		onActivityStart?.(elementApi.id, elementApi.name ?? elementApi.id);
	});

	listener.on("activity.end", (elementApi: { id: string; name?: string }) => {
		if (options.graphView) {
			options.graphView.setNodeStatus(elementApi.id, "done");
			options.onGraphUpdate?.();
		}
		onActivityEnd?.(elementApi.id, elementApi.name ?? elementApi.id);
	});

	listener.on("activity.error", (elementApi: { id: string }) => {
		if (options.graphView) {
			options.graphView.setNodeStatus(elementApi.id, "error");
			options.onGraphUpdate?.();
		}
	});

	listener.on("flow.take", (flow: { id: string; sourceId?: string; targetId?: string }) => {
		if (options.graphView && flow.sourceId && flow.targetId) {
			options.graphView.setEdgeTaken(flow.sourceId, flow.targetId);
			options.onGraphUpdate?.();
		}
		onFlowTake?.(flow.id);
	});

	// Create and execute the engine
	const engine = new Engine({
		name: "skillsx",
		source,
		moddleOptions: options.moddleOptions,
		extensions: {
			skillsc: skillscExtension as unknown as import("bpmn-elements").Extension,
		},
	});

	try {
		// Build graph view from definitions if requested
		if (options.graphView) {
			const definitions = await engine.getDefinitions();
			for (const def of definitions) {
				populateGraphView(options.graphView, def);
			}
			options.onGraphReady?.();
		}

		const execution = await engine.execute({
			listener,
			variables: initialVariables,
			services: {
				runAgent,
			},
		});

		// Wait for the engine to complete
		await engine.waitFor("end");

		// Variables live on the definition's environment, not the execution's
		const defs = execution.definitions;
		const defEnv = defs[0]?.environment;

		return {
			success: true,
			variables: defEnv?.variables ?? {},
			output: defEnv?.output ?? {},
		};
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		onError?.(error);
		return {
			success: false,
			error: error.message,
			variables: {},
			output: {},
		};
	}
}

/**
 * Populate a GraphView from a bpmn-engine Definition.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function populateGraphView(view: GraphView, definition: any): void {
	const ctx = definition.context;
	if (!ctx) return;

	const activities = ctx.getActivities?.() ?? [];
	const flows = ctx.getSequenceFlows?.() ?? [];

	for (const act of activities) {
		let type: "start" | "end" | "task" | "gateway" | "boundary" = "task";
		const bpmnType = act.type as string;
		if (bpmnType.includes("StartEvent")) type = "start";
		else if (bpmnType.includes("EndEvent")) type = "end";
		else if (bpmnType.includes("Gateway")) type = "gateway";
		else if (bpmnType.includes("BoundaryEvent")) type = "boundary";

		view.addNode({
			id: act.id,
			label: act.name ?? act.id,
			type,
			status: "pending",
		});
	}

	for (const flow of flows) {
		const sourceId = flow.behaviour?.sourceRef?.id ?? flow.sourceId;
		const targetId = flow.behaviour?.targetRef?.id ?? flow.targetId;
		if (sourceId && targetId) {
			view.addEdge({
				source: sourceId,
				target: targetId,
				label: flow.behaviour?.name,
				taken: false,
			});
		}
	}
}
