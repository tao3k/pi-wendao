import { describe, expect, it } from "vitest";
import { resolveQianjiInteractionReply } from "../../src/cli/qianji-interaction-prompt.js";
import type { QianjiInteraction } from "../../src/executor/agent-host.js";

describe("qianji interaction prompt replies", () => {
  it("returns selected choice values from the BPMN interaction contract", () => {
    const interaction: QianjiInteraction = {
      type: "choice",
      choices: [
        { value: "expand", label: "Explore more" },
        { value: "narrow", label: "Narrow scope" },
      ],
    };

    expect(resolveQianjiInteractionReply(interaction, interaction.choices![1])).toBe("narrow");
  });

  it("returns free-form text for input interactions", () => {
    expect(
      resolveQianjiInteractionReply({ type: "input" }, undefined, "  find three product angles  "),
    ).toBe("find three product angles");
  });

  it("lets choice_input free-form text override the selected choice", () => {
    const interaction: QianjiInteraction = {
      type: "choice_input",
      choices: [{ value: "expand", label: "Explore more" }],
    };

    expect(
      resolveQianjiInteractionReply(interaction, interaction.choices![0], "custom direction"),
    ).toBe("custom direction");
  });

  it("defaults confirm interactions to approved when no explicit choice is provided", () => {
    expect(resolveQianjiInteractionReply({ type: "confirm" })).toBe("approved");
  });
});
