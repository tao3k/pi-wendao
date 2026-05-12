import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveSearchStrategyFlowPrecisionGatePlan,
  type SearchStrategyFlowPrecisionGateName,
} from "../../src/cli/search/strategy-flow-precision-gate.js";

describe("SearchStrategyFlow precision gate wrapper", () => {
  it("points pi-wendao precision checks at WendaoGraph authority gates", () => {
    const plan = resolveSearchStrategyFlowPrecisionGatePlan({
      packageRoot: "/repo/.data/pi-wendao",
      juliaCommand: "julia",
    });

    expect(plan.wendaoGraphDir).toBe(join("/repo/.data/pi-wendao", "..", "WendaoGraph.jl"));
    expect(plan.commands.map((command) => command.gate)).toEqual([
      "materialized_precision",
      "real_scenarios",
      "stratified_live_intents",
    ]);
    expect(plan.commands.map((command) => command.args.join(" "))).toEqual([
      "--project=. test/reasoning/search_strategy_flow_materialized_precision.jl",
      "--project=. test/reasoning/search_strategy_flow_real_scenarios.jl",
      "--project=. test/reasoning/search_strategy_flow_stratified_live_intents.jl",
    ]);
  });

  it("can narrow to one explicit gate for focused debugging", () => {
    const gates: SearchStrategyFlowPrecisionGateName[] = ["materialized_precision"];
    const plan = resolveSearchStrategyFlowPrecisionGatePlan({
      packageRoot: "/repo/.data/pi-wendao",
      juliaCommand: "julia",
      gates,
    });

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      gate: "materialized_precision",
      command: "julia",
      cwd: join("/repo/.data/pi-wendao", "..", "WendaoGraph.jl"),
    });
  });
});
