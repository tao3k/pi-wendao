import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { buildCompilePrompt } from "./prompt.js";

export interface CompileOptions {
	/** Raw markdown content of the skill file */
	skillContent: string;
	/** Large model to use for compilation */
	model: Model<string>;
	/** API key for the model provider */
	apiKey?: string;
}

export interface CompileResult {
	success: boolean;
	bpmnXml?: string;
	errors?: string[];
}

/**
 * Compile a skill markdown file into BPMN 2.0 XML using a large model.
 */
export async function compileSkill(options: CompileOptions): Promise<CompileResult> {
	const { systemPrompt, userMessage } = buildCompilePrompt(options.skillContent);

	const stream = streamSimple(options.model, {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }],
	}, {
		apiKey: options.apiKey,
	});

	const result = await stream.result();

	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("");

	if (result.stopReason === "error") {
		return { success: false, errors: [result.errorMessage ?? "Model returned an error"] };
	}

	// Extract XML from the response (may be wrapped in code fences)
	const xml = extractXml(text);
	if (!xml) {
		return { success: false, errors: ["No valid XML found in model response"] };
	}

	return { success: true, bpmnXml: xml };
}

/**
 * Extract XML content from text that may be wrapped in markdown code fences.
 */
function extractXml(text: string): string | undefined {
	// Try code block first
	const codeBlockMatch = text.match(/```(?:xml)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlockMatch) {
		const content = codeBlockMatch[1].trim();
		if (content.startsWith("<?xml") || content.startsWith("<definitions") || content.startsWith("<bpmn:definitions")) {
			return content;
		}
	}

	// Try raw XML
	const trimmed = text.trim();
	if (trimmed.startsWith("<?xml") || trimmed.startsWith("<definitions") || trimmed.startsWith("<bpmn:definitions")) {
		return trimmed;
	}

	return undefined;
}
