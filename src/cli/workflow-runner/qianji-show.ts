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