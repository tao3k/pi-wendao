import { describe, expect, it, vi } from "vitest";

const piSubagentsMock = vi.hoisted(() => ({
  registeredPi: undefined as undefined | {
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => unknown },
    ): void;
  },
}));

vi.mock("@tintinweb/pi-subagents/dist/index.js", () => ({
  default: (pi: typeof piSubagentsMock.registeredPi) => {
    piSubagentsMock.registeredPi = pi;
  },
}));

import registerPiWendaoPiSubagents, {
  PI_WENDAO_RESET_NATIVE_SESSION_SURFACES_EVENT,
} from "../../src/cli/native/pi-subagents-extension.js";

describe("pi-wendao native pi-subagents extension", () => {
  it("hides late pi-subagents overlays after native session reset", async () => {
    const calls: string[] = [];
    let resetHandler: (() => void) | undefined;
    let registeredCommand:
      | { handler: (args: string, ctx: unknown) => Promise<void> | void }
      | undefined;

    registerPiWendaoPiSubagents({
      events: {
        on: (channel: string, handler: () => void) => {
          if (channel === PI_WENDAO_RESET_NATIVE_SESSION_SURFACES_EVENT) {
            resetHandler = handler;
          }
        },
      },
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: unknown) => Promise<void> | void },
      ) => {
        registeredCommand = options;
      },
      on: () => undefined,
      registerTool: () => undefined,
    } as never);

    piSubagentsMock.registeredPi?.registerCommand("subagents", {
      handler: async (_args, ctx) => {
        await (ctx as {
          ui: {
            custom<T>(
              factory: () => T,
              options: { overlay: true; onHandle?: (handle: { hide(): void }) => void },
            ): Promise<T>;
          };
        }).ui.custom(() => undefined, {
          overlay: true,
          onHandle: () => calls.push("consumerHandle"),
        });
      },
    });

    let lateHandle: ((handle: { hide(): void }) => void) | undefined;
    const neverSettles = new Promise<undefined>(() => undefined);
    const ctx = {
      ui: {
        custom: (
          _factory: () => undefined,
          options: { onHandle?: (handle: { hide(): void }) => void },
        ) => {
          lateHandle = options.onHandle;
          return neverSettles;
        },
        setWidget: (key: string, value: unknown) =>
          calls.push(value ? `widget:${key}` : `clearWidget:${key}`),
        setStatus: (key: string, value: string | undefined) =>
          calls.push(value ? `status:${key}` : `clearStatus:${key}`),
      },
    };

    void registeredCommand?.handler("", ctx);
    resetHandler?.();
    lateHandle?.({ hide: () => calls.push("lateHide") });

    expect(calls).toEqual(["clearWidget:agents", "clearStatus:subagents", "lateHide"]);
  });
});
