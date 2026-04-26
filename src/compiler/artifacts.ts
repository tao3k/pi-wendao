import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { CompileArtifact, CompileArtifactBundle, CompileArtifactTarget } from "./types.js";

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

export function extractArtifactBundle(
  text: string,
  target: CompileArtifactTarget,
): CompileArtifactBundle | undefined {
  if (target === "bpmn") {
    const bpmnXml = extractXml(text);
    return bpmnXml
      ? {
          bpmnXml,
          artifacts: [{ kind: "bpmn", content: bpmnXml }],
        }
      : undefined;
  }

  const fencedArtifacts = extractFencedXmlArtifacts(text);
  const bpmnXml = fencedArtifacts.find((artifact) => artifact.kind === "bpmn")?.content;
  const dmnXml = fencedArtifacts.find((artifact) => artifact.kind === "dmn")?.content;
  if (!bpmnXml || !dmnXml) return undefined;
  return {
    bpmnXml,
    dmnXml,
    artifacts: [
      { kind: "bpmn", content: bpmnXml },
      { kind: "dmn", content: dmnXml },
    ],
  };
}

export function missingArtifactMessage(target: CompileArtifactTarget): string {
  if (target === "bpmn") return "No valid XML found in model response";
  return "No valid BPMN+DMN artifact bundle found in model response";
}

export function renderArtifactBundleForPrompt(bundle: CompileArtifactBundle | undefined): string {
  if (!bundle) return "(no previous artifacts)";
  const blocks = [`\`\`\`bpmn\n${bundle.bpmnXml}\n\`\`\``];
  if (bundle.dmnXml) blocks.push(`\`\`\`dmn\n${bundle.dmnXml}\n\`\`\``);
  return blocks.join("\n\n");
}

function extractFencedXmlArtifacts(text: string): CompileArtifact[] {
  const artifacts: CompileArtifact[] = [];
  const codeBlockPattern = /```([^\n`]*)\n?([\s\S]*?)\n?```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockPattern.exec(text)) !== null) {
    const info = match[1].toLowerCase();
    const content = match[2].trim();
    if (!content) continue;
    const kind = classifyXmlArtifact(info, content);
    if (kind) artifacts.push({ kind, content });
  }
  return artifacts;
}

function classifyXmlArtifact(info: string, content: string): "bpmn" | "dmn" | undefined {
  if (info.includes("bpmn")) return "bpmn";
  if (info.includes("dmn")) return "dmn";
  if (
    content.includes("BPMN/20100524/MODEL") ||
    content.includes("<bpmn:definitions") ||
    content.includes("<businessRuleTask") ||
    content.includes("<bpmn:businessRuleTask")
  ) {
    return "bpmn";
  }
  if (
    content.includes("DMN/") ||
    content.includes("<dmn:definitions") ||
    content.includes("<decision ")
  ) {
    return "dmn";
  }
  return undefined;
}

/**
 * Extract XML content from text that may be wrapped in markdown code fences.
 */
function extractXml(text: string): string | undefined {
  const fenced = extractFencedXmlArtifacts(text).find((artifact) => artifact.kind === "bpmn");
  if (fenced) return fenced.content;

  const trimmed = text.trim();
  if (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<definitions") ||
    trimmed.startsWith("<bpmn:definitions")
  ) {
    return trimmed;
  }

  return undefined;
}
