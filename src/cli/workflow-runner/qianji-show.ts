import { spawn } from "node:child_process";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
});
const BPMN_NODE_ELEMENTS = [
  "startEvent",
  "endEvent",
  "serviceTask",
  "task",
  "userTask",
  "scriptTask",
  "businessRuleTask",
  "sendTask",
  "receiveTask",
  "manualTask",
  "callActivity",
  "subProcess",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "complexGateway",
  "boundaryEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
];

export function runQianjiShow(options: {
  command: string;
  instanceId?: string;
  workflowPath?: string;
  dmnPaths: string[];
  cwd: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const args = options.instanceId
    ? ["bpmn", "status", "--instance-id", options.instanceId]
    : ["bpmn", "instances"];
  if (options.instanceId) {
    if (options.workflowPath) {
      args.push("--bpmn", options.workflowPath);
    }
    for (const dmnPath of options.dmnPaths) {
      args.push("--dmn", dmnPath);
    }
  }
  const commandLine = [options.command, ...args.map(shellQuote)].join(" ");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandLine, {
      cwd: options.cwd,
      shell: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

interface QianjiServerStatusResponse {
  checkpoint_sequence?: number;
  checkpoint_backend?: string;
  workflow?: QianjiServerWorkflowSnapshot;
}

interface QianjiServerCancelResponse {
  cancelled?: boolean;
  checkpoint_sequence?: number;
  checkpoint_backend?: string;
  workflow?: QianjiServerWorkflowSnapshot;
}

interface QianjiServerWorkflowSnapshot {
  instance_id?: string;
  process_id?: string;
  sequence?: number;
  lifecycle?: string;
  pending_host_work_count?: number;
  pending_host_work?: Array<{
    token_id?: number;
    kind?: string;
    node_id?: string | null;
    activity_id?: string | null;
    process_id?: string | null;
  }>;
  wait_registration_count?: number;
  active_token_count?: number;
}

type QianjiServerPendingHostWork = NonNullable<
  NonNullable<QianjiServerStatusResponse["workflow"]>["pending_host_work"]
>[number];

export async function runQianjiServerShow(options: {
  serverUrl: string;
  instanceId: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const url = new URL(
    `/workflows/${encodeURIComponent(options.instanceId)}`,
    ensureTrailingSlash(options.serverUrl),
  );
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `qianji-server status failed with HTTP ${response.status}: ${text}`,
    };
  }
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!isQianjiServerStatusResponse(parsed)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "qianji-server status returned an invalid workflow response",
    };
  }
  return {
    exitCode: 0,
    stdout: renderQianjiServerStatus(parsed),
    stderr: "",
  };
}

export async function runQianjiServerCancel(options: {
  serverUrl: string;
  instanceId: string;
  workflowPath: string;
  dmnPaths: string[];
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const url = new URL(
    `/workflows/${encodeURIComponent(options.instanceId)}/cancel`,
    ensureTrailingSlash(options.serverUrl),
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bpmn_path: options.workflowPath,
      dmn_paths: options.dmnPaths,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `qianji-server cancel failed with HTTP ${response.status}: ${text}`,
    };
  }
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!isQianjiServerCancelResponse(parsed)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "qianji-server cancel returned an invalid workflow response",
    };
  }
  return {
    exitCode: 0,
    stdout: renderQianjiServerCancel(parsed),
    stderr: "",
  };
}

export function appendActiveBpmnNodeLabels(
  output: string,
  source: string,
  processId?: string,
): string {
  const graphSnapshotIndex = output.indexOf("## Graph Snapshot");
  const statusHeader = graphSnapshotIndex === -1 ? output : output.slice(0, graphSnapshotIndex);
  const activeNodeIds = Array.from(statusHeader.matchAll(/\bnode_id=([A-Za-z][A-Za-z0-9_.:-]*)/g))
    .map((match) => match[1])
    .filter((nodeId, index, nodeIds) => nodeIds.indexOf(nodeId) === index);
  if (activeNodeIds.length === 0) return output;

  const labels = buildBpmnNodeLabelMap(source, processId);
  const lines = activeNodeIds.map((nodeId) => {
    const label = labels.get(nodeId);
    return label && label !== nodeId ? `- ${nodeId} | ${label}` : `- ${nodeId}`;
  });
  return `${output.trimEnd()}\n\n## Active BPMN Nodes\n${lines.join("\n")}\n`;
}

function renderQianjiServerStatus(status: QianjiServerStatusResponse): string {
  const workflow = status.workflow ?? {};
  const pendingHostWork = workflow.pending_host_work ?? [];
  const lines = [
    "# BPMN Server Workflow",
    "",
    "Outcome: blocked_on_host",
    ...(status.checkpoint_backend ? [`Checkpoint backend: ${status.checkpoint_backend}`] : []),
    "Checkpoint source: qianji-server",
    ...(status.checkpoint_sequence !== undefined
      ? [`Checkpoint sequence: ${status.checkpoint_sequence}`]
      : []),
    `Pending host work: ${workflow.pending_host_work_count ?? pendingHostWork.length}`,
    ...(workflow.lifecycle ? [`Lifecycle: ${workflow.lifecycle}`] : []),
    ...(workflow.active_token_count !== undefined
      ? [`Active tokens: ${workflow.active_token_count}`]
      : []),
    ...(workflow.wait_registration_count !== undefined
      ? [`Wait registrations: ${workflow.wait_registration_count}`]
      : []),
    "",
    "## Pending Host Work",
    ...(pendingHostWork.length > 0
      ? pendingHostWork.map(formatQianjiServerPendingHostWork)
      : ["- none"]),
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderQianjiServerCancel(cancel: QianjiServerCancelResponse): string {
  const workflow = cancel.workflow ?? {};
  const pendingHostWork = workflow.pending_host_work ?? [];
  const lines = [
    "# BPMN Server Workflow Cancel",
    "",
    `Cancelled: ${cancel.cancelled === true ? "yes" : "no"}`,
    ...(cancel.checkpoint_backend ? [`Checkpoint backend: ${cancel.checkpoint_backend}`] : []),
    "Checkpoint source: qianji-server",
    ...(cancel.checkpoint_sequence !== undefined
      ? [`Checkpoint sequence: ${cancel.checkpoint_sequence}`]
      : []),
    `Pending host work before cancel: ${workflow.pending_host_work_count ?? pendingHostWork.length}`,
    ...(workflow.lifecycle ? [`Lifecycle before cancel: ${workflow.lifecycle}`] : []),
    "",
    "## Pending Host Work Before Cancel",
    ...(pendingHostWork.length > 0
      ? pendingHostWork.map(formatQianjiServerPendingHostWork)
      : ["- none"]),
    "",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatQianjiServerPendingHostWork(work: QianjiServerPendingHostWork): string {
  const nodeId = work.node_id?.trim() || work.activity_id?.trim() || "unknown";
  const token = work.token_id === undefined ? "?" : String(work.token_id);
  const kind = work.kind ?? "unknown";
  const process = work.process_id ? ` | process=${work.process_id}` : "";
  return `- node_id=${nodeId} | token#${token} | kind=${kind}${process}`;
}

function isQianjiServerStatusResponse(value: unknown): value is QianjiServerStatusResponse {
  return !!value && typeof value === "object" && "workflow" in value;
}

function isQianjiServerCancelResponse(value: unknown): value is QianjiServerCancelResponse {
  return !!value && typeof value === "object" && "workflow" in value && "cancelled" in value;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildBpmnNodeLabelMap(source: string, processId?: string): Map<string, string> {
  const document = parser.parse(source) as { definitions?: { process?: unknown } };
  const process = findProcess(document.definitions?.process, processId);
  const labels = new Map<string, string>();
  if (!process) return labels;
  for (const elementName of BPMN_NODE_ELEMENTS) {
    for (const node of asArray(process[elementName])) {
      if (!isObject(node)) continue;
      const id = readString(node.id);
      if (!id) continue;
      labels.set(id, readString(node.name) || id);
    }
  }
  return labels;
}

function findProcess(processes: unknown, processId?: string): Record<string, unknown> | undefined {
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    const id = readString(process.id);
    if (!id) continue;
    if (!processId || id === processId) return process;
  }
  return undefined;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
