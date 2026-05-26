import { resolve as resolvePath } from "node:path";
import { readServerlessMemoryRecallPacketFile } from "../serverless-memory/index.js";
import type { ServerlessMemoryRecallPacket } from "../serverless-memory/index.js";

export interface NativeChatStartupInput {
  invocationCwd: string;
  workflowPath?: string;
  flowhubScenario?: string;
  cancel?: boolean;
  show?: boolean;
  tui?: boolean;
  stdinIsTTY: boolean;
  serverlessMemoryRecallJson?: string;
}

export interface NativeChatStartupResolution {
  shouldLaunchNativeChat: boolean;
  serverlessMemoryRecallPacket?: ServerlessMemoryRecallPacket;
}

export function resolveNativeChatStartup(
  input: NativeChatStartupInput,
): NativeChatStartupResolution {
  const shouldLaunchNativeChat =
    !input.workflowPath &&
    !input.flowhubScenario &&
    input.cancel !== true &&
    input.show !== true &&
    input.tui === true &&
    input.stdinIsTTY;
  const serverlessMemoryRecallPacket = input.serverlessMemoryRecallJson
    ? readServerlessMemoryRecallPacketFile(
        resolvePath(input.invocationCwd, input.serverlessMemoryRecallJson),
      )
    : undefined;
  if (serverlessMemoryRecallPacket && !shouldLaunchNativeChat) {
    throw new Error(
      "--serverless-memory-recall-json currently applies only to native pi chat startup",
    );
  }
  return {
    shouldLaunchNativeChat,
    serverlessMemoryRecallPacket,
  };
}
