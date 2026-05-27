import { describe, expect, it } from "vitest";
import {
  appendPiSubagentActivityEvent,
  createPiSubagentActivity,
  summarizePiSubagentActivity,
} from "../src/subagents/activity.js";

describe("subagent activity DTO helpers", () => {
  it("summarizes command, file, duration, and terminal state", () => {
    const started = createPiSubagentActivity({
      id: "activity-1",
      title: "Edited files",
      description: "Run a child agent",
      now: 1000,
    });
    const withCommand = appendPiSubagentActivityEvent(started, {
      kind: "tool_call",
      activityId: "Task_Edit",
      description: "Edit source",
      toolName: "edit",
      toolCallId: "tool-1",
      timestamp: 1200,
    });
    const completed = appendPiSubagentActivityEvent(withCommand, {
      kind: "result",
      activityId: "Task_Edit",
      description: "Done",
      text: "changed two files",
      timestamp: 2400,
    });

    expect(completed.state).toBe("completed");
    expect(summarizePiSubagentActivity(completed)).toMatchObject({
      commandCount: 1,
      durationMs: 1400,
      eventCount: 2,
      failedCount: 0,
      editCount: 1,
      fileCount: 1,
      readCount: 0,
      searchCount: 0,
      state: "completed",
      title: "Edited files",
    });
  });
});
