import type { Effect } from "effect";
import { streamSimple } from "@earendil-works/pi-ai";
import { buildTargetDecisionPrompt, type CompileTargetDecision } from "./prompt.js";
import type { CompileOptions } from "./types.js";
import { asArray, extractJsonObject, isObject, readString } from "./json.js";
import { effectFromPromise, type PiWendaoEffectError } from "../effect.js";

export function decideCompileTarget(
  options: CompileOptions,
  skillContent: string,
  constructIndex: string,
): Effect.Effect<CompileTargetDecision, PiWendaoEffectError> {
  return effectFromPromise("decideCompileTarget", () =>
    decideCompileTargetPromise(options, skillContent, constructIndex),
  );
}

async function decideCompileTargetPromise(
  options: CompileOptions,
  skillContent: string,
  constructIndex: string,
): Promise<CompileTargetDecision> {
  if (options.target?.runner) {
    return normalizeCompileTargetDecision(
      await options.target.runner(skillContent, {
        model: options.model,
        apiKey: options.apiKey,
        headers: options.headers,
      }),
    );
  }

  options.target?.onMessage?.("choosing BPMN/DMN compile target");
  const { systemPrompt, userMessage } = buildTargetDecisionPrompt(skillContent, constructIndex);
  const stream = streamSimple(
    options.model,
    {
      systemPrompt,
      messages: [
        { role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() },
      ],
    },
    {
      apiKey: options.apiKey,
      headers: options.headers,
    },
  );
  const result = await stream.result();
  if (result.stopReason === "error") {
    throw new Error(result.errorMessage ?? "Model returned an error while choosing compile target");
  }
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");
  return normalizeCompileTargetDecision(parseCompileTargetDecision(text));
}

function parseCompileTargetDecision(text: string): CompileTargetDecision {
  const json = extractJsonObject(text);
  if (!json) {
    throw new Error("No compile target JSON found in model response");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Invalid compile target JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isObject(value)) {
    throw new Error("Compile target JSON must be an object");
  }
  const rawTarget = readString(value.target).toLowerCase();
  const reason = readString(value.reason) || "Model selected artifact target from raw SKILL.md.";
  const dmnDecisions = asArray(value.dmnDecisions)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const selectedConstructs = asArray(value.selectedConstructs)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const scenario = readScenario(value.scenario);
  if (rawTarget === "bpmn" || rawTarget === "bpmn-dmn" || rawTarget === "bpmn+dmn") {
    return {
      target: rawTarget === "bpmn" ? "bpmn" : "bpmn-dmn",
      reason,
      dmnDecisions,
      ...(scenario ? { scenario } : {}),
      ...(selectedConstructs.length > 0 ? { selectedConstructs } : {}),
    };
  }
  if (rawTarget === "dmn") {
    return {
      target: "bpmn-dmn",
      reason: `${reason} Pure DMN is normalized to BPMN+DMN because pi-wendao executes BPMN workflows.`,
      dmnDecisions,
      ...(scenario ? { scenario } : {}),
      ...(selectedConstructs.length > 0 ? { selectedConstructs } : {}),
      normalizedFrom: "dmn",
    };
  }
  throw new Error(`Unsupported compile target '${rawTarget || "(missing)"}'`);
}

function normalizeCompileTargetDecision(decision: CompileTargetDecision): CompileTargetDecision {
  if (decision.target === "bpmn-dmn" || decision.target === "bpmn") {
    return {
      target: decision.target,
      reason: decision.reason || "Model selected artifact target from raw SKILL.md.",
      dmnDecisions: decision.dmnDecisions ?? [],
      ...(decision.scenario ? { scenario: decision.scenario } : {}),
      selectedConstructs: selectedConstructIds(decision),
      ...(decision.normalizedFrom ? { normalizedFrom: decision.normalizedFrom } : {}),
    };
  }
  return {
    target: "bpmn-dmn",
    reason: `${decision.reason || "Model selected pure DMN."} Pure DMN is normalized to BPMN+DMN because pi-wendao executes BPMN workflows.`,
    dmnDecisions: decision.dmnDecisions ?? [],
    ...(decision.scenario ? { scenario: decision.scenario } : {}),
    selectedConstructs: selectedConstructIds({ ...decision, target: "bpmn-dmn" }),
    normalizedFrom: "dmn",
  };
}

export function selectedConstructIds(decision: CompileTargetDecision): string[] {
  const ids = [
    ...(decision.selectedConstructs ?? []),
    "service-task.agent",
    ...(decision.scenario === "interactive" || decision.scenario === "planning"
      ? ["user-task.interaction"]
      : []),
    ...(decision.target === "bpmn-dmn" ? ["dmn.decision-table.unique"] : []),
  ];
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function readScenario(value: unknown): CompileTargetDecision["scenario"] | undefined {
  const scenario = readString(value).toLowerCase();
  if (scenario === "autonomous" || scenario === "interactive" || scenario === "planning") {
    return scenario;
  }
  return undefined;
}
