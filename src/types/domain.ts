export type Branded<T, BrandName extends string> = T & {
  readonly __brand?: string;
} & (BrandName extends string ? unknown : never);

export type ActivityId = Branded<string, "ActivityId">;
export type AgentId = Branded<string, "AgentId">;
export type ApiKey = Branded<string, "ApiKey">;
export type DmnPath = Branded<string, "DmnPath">;
export type EventFixturePath = Branded<string, "EventFixturePath">;
export type HostFixturePath = Branded<string, "HostFixturePath">;
export type InstanceId = Branded<string, "InstanceId">;
export type NodeId = Branded<string, "NodeId">;
export type NodeIndex = number;
export type ProcessId = Branded<string, "ProcessId">;
export type QianjiCommand = string;
export type QianjiWorkflowServerUrl = Branded<string, "QianjiWorkflowServerUrl">;
export type QianjiWorkflowStateDuckdbPath = Branded<string, "QianjiWorkflowStateDuckdbPath">;
export type RunRecordKey = Branded<string, "RunRecordKey">;
export type RunStorePath = Branded<string, "RunStorePath">;
export type SourcePath = Branded<string, "SourcePath">;
export type TokenId = Branded<number, "TokenId">;
export type ToolCallId = Branded<string, "ToolCallId">;
export type TraceFrameDelayMs = Branded<number, "TraceFrameDelayMs">;
export type WorkflowPath = Branded<string, "WorkflowPath">;

export type PiWendaoSubagentType = Branded<string, "PiWendaoSubagentType">;
export type QianjiNodeKind = Branded<string, "QianjiNodeKind">;
export type QianjiNodeStatus = Branded<string, "QianjiNodeStatus">;
