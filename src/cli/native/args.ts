import { validateInstanceId } from "../instance-id.js";
import { isBrainstormTypo, parseNamedWorkflowName } from "../named-workflows.js";
import type { NativeRunCommand, NativeShowCommand } from "./types.js";

export function parseNativeRunCommand(args: string): NativeRunCommand {
  const words = splitCommandWords(args);
  if (words.length === 0) {
    throw new Error(
      "Usage: /run <workflow.bpmn> [--instance-id id] [--start-at-node node_id] [--dmn file] [--host-fixture file] [--var key=value]",
    );
  }
  const workflowPath = words[0]!;
  const namedWorkflow = parseNamedWorkflowName(workflowPath);
  const command: NativeRunCommand = {
    workflowPath,
    ...(namedWorkflow ? { namedWorkflow } : {}),
    dmnPaths: [],
    variables: [],
    graph: true,
  };
  if (isBrainstormTypo(command.workflowPath)) {
    throw new Error("Unknown named workflow 'brainstrom'. Use '/run brainstorm'.");
  }
  for (let index = 1; index < words.length; index += 1) {
    const flag = words[index]!;
    switch (flag) {
      case "--process":
        command.process = readRequiredValue(words, ++index, flag);
        break;
      case "--instance-id":
        command.instanceId = validateInstanceId(readRequiredValue(words, ++index, flag));
        break;
      case "--start-at-node":
        command.startAtNode = readRequiredValue(words, ++index, flag);
        break;
      case "--qianji":
        command.qianji = readRequiredValue(words, ++index, flag);
        break;
      case "--dmn":
        command.dmnPaths.push(readRequiredValue(words, ++index, flag));
        break;
      case "--host-fixture":
        command.hostFixturePath = readRequiredValue(words, ++index, flag);
        break;
      case "--event-fixture":
        command.eventFixturePath = readRequiredValue(words, ++index, flag);
        break;
      case "--context-json":
        command.contextJson = readRequiredValue(words, ++index, flag);
        break;
      case "--trace-frame-ms":
        command.traceFrameMs = parseNonNegativeNumber(
          readRequiredValue(words, ++index, flag),
          flag,
        );
        break;
      case "--var":
        command.variables.push(readRequiredValue(words, ++index, flag));
        break;
      case "--no-graph":
      case "--no-tui":
        command.graph = false;
        break;
      default:
        throw new Error(`Unknown /run option: ${flag}`);
    }
  }
  return command;
}

export function parseNativeShowCommand(args: string): NativeShowCommand {
  const words = splitCommandWords(args);
  const command: NativeShowCommand = { dmnPaths: [] };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--dmn") {
      command.dmnPaths.push(readRequiredValue(words, ++index, word));
    } else if (!command.instanceId) {
      command.instanceId = validateInstanceId(word);
    } else if (!command.workflowPath) {
      command.workflowPath = word;
    } else {
      throw new Error(`Unexpected /show argument: ${word}`);
    }
  }
  return command;
}

function splitCommandWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("Unclosed quote in command arguments");
  if (escaping) current += "\\";
  if (current) words.push(current);
  return words;
}

function readRequiredValue(words: string[], index: number, flag: string): string {
  const value = words[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseNonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}
