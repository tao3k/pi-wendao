import { describe, expect, it } from "vitest";
import { validateInstanceId } from "../../src/cli/instance-id.js";

describe("validateInstanceId", () => {
  it("accepts stable descriptive ids", () => {
    expect(validateInstanceId("pi-wendao-real-llm-complex-20260424")).toBe(
      "pi-wendao-real-llm-complex-20260424",
    );
    expect(validateInstanceId("wf_test")).toBe("wf_test");
  });

  it("rejects accidental numeric or shell-hostile ids", () => {
    expect(() => validateInstanceId("5")).toThrow(/invalid --instance-id/);
    expect(() => validateInstanceId("bad id")).toThrow(/invalid --instance-id/);
    expect(() => validateInstanceId("-bad")).toThrow(/invalid --instance-id/);
  });
});
