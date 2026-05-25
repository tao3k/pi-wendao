import { afterEach, describe, expect, it } from "vitest";
import { resolveSearchStrategyFlowRustCommandOverride } from "../../src/cli/search/strategy-flow-julia.js";

const ORIGINAL_CARGO = process.env.CARGO;
const ORIGINAL_SEARCH_RUST_COMMAND = process.env.PI_WENDAO_SEARCH_RUST_COMMAND;

describe("SearchStrategyFlow Julia/Rust bridge command resolution", () => {
  afterEach(() => {
    restoreEnv("CARGO", ORIGINAL_CARGO);
    restoreEnv("PI_WENDAO_SEARCH_RUST_COMMAND", ORIGINAL_SEARCH_RUST_COMMAND);
  });

  it("ignores generic CARGO and only accepts explicit SearchStrategyFlow overrides", () => {
    process.env.CARGO = "cargo test -p xiuxian-wendao --ignored";
    delete process.env.PI_WENDAO_SEARCH_RUST_COMMAND;

    expect(resolveSearchStrategyFlowRustCommandOverride({})).toBeUndefined();
  });

  it("prefers the CLI command over the SearchStrategyFlow environment override", () => {
    process.env.PI_WENDAO_SEARCH_RUST_COMMAND = "env-cargo";

    expect(resolveSearchStrategyFlowRustCommandOverride({ rustCommand: "cli-cargo" })).toBe(
      "cli-cargo",
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
