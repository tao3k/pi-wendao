import type { GraphView } from "../graph-view.js";
import type { QianjiInteraction } from "../../executor/agent-host.js";
import type { PiWendaoAgentEvent } from "../../executor/agent-runtime-types.js";

export interface Renderer {
  graphView: GraphView;
  onAgentEvent: (event: PiWendaoAgentEvent) => void;
  onNodeStart: (activityId: string, activityName: string) => void;
  onNodeEnd: (activityId: string, activityName: string) => void;
  onFlowTake: (flowId: string) => void;
  onTraceEvent: (event: QianjiTraceLogEvent) => void;
  onError: (err: Error) => void;
  printVariables: (variables: Record<string, unknown>) => void;
  appendLog: (text: string) => void;
  requestPlannerReply: (request: PlannerReplyRequest, signal?: AbortSignal) => Promise<string>;
  waitForKey: () => Promise<void>;
  refresh: () => void;
  start: () => void;
  stop: () => void;
}

export interface PlannerReplyRequest {
  toolCallId: string;
  action: string;
  to: string;
  message: string;
  interaction?: QianjiInteraction;
  context?: {
    activityId: string;
    description: string;
    agentId?: string;
  };
}

export type QianjiTraceLogEvent =
  | { kind: "node_status"; node_id: string; node_kind?: string | null; status: string }
  | { kind: "flow_take"; source_id: string; target_id: string };

export interface QianjiHostWorkLogEvent {
  activityId: string;
  hostWorkCount: number;
  batchHostWorkCount: number;
  tokenIds: number[];
  hostKinds: string[];
  parallel: boolean;
  repeatKinds: string[];
  repeatSummaries: string[];
}

export type PiSubagentsHostLogEvent =
  | {
      type: "spawned" | "resumed" | "waiting";
      activityId: string;
      agentId: string;
      description: string;
    }
  | {
      type: "result";
      activityId: string;
      agentId: string;
      description: string;
      resultText: string;
    };

export type PiSubagentsHostToolLogEvent =
  | {
      type: "tool_call";
      activityId: string;
      agentId?: string;
      description: string;
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      activityId: string;
      agentId?: string;
      description: string;
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
      content: unknown;
      details?: unknown;
      isError: boolean;
    };
