export interface BPMNProcess {
	id: string;
	name: string;
	elements: BPMNElement[];
	flows: SequenceFlow[];
	variables: ProcessVariable[];
}

export type BPMNElement = StartEvent | EndEvent | TaskNode | ExclusiveGateway | ParallelGateway | BoundaryErrorEvent;

export interface StartEvent {
	type: "startEvent";
	id: string;
	name?: string;
}

export interface EndEvent {
	type: "endEvent";
	id: string;
	name?: string;
}

export interface TaskNode {
	type: "task";
	id: string;
	name: string;
	prompt: string;
	tools: string[]; // e.g. ["bash", "read", "edit", "write"]
	inputs: string[]; // variable names this task reads
	outputs: string[]; // variable names this task writes
}

export interface ExclusiveGateway {
	type: "exclusiveGateway";
	id: string;
	name?: string;
	/** If set, the small model evaluates the gateway decision */
	gatewayPrompt?: string;
}

export interface ParallelGateway {
	type: "parallelGateway";
	id: string;
	name?: string;
}

export interface BoundaryErrorEvent {
	type: "boundaryErrorEvent";
	id: string;
	name?: string;
	attachedToRef: string; // task ID this is attached to
}

export interface SequenceFlow {
	id: string;
	sourceRef: string;
	targetRef: string;
	name?: string;
	/** JS expression evaluated against variable store, e.g. "${testsPassed === true}" */
	conditionExpression?: string;
}

export interface ProcessVariable {
	name: string;
	defaultValue?: string;
}
