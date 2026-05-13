import type { Command } from "commander";
import { parseNonNegativeInt } from "../number-options.js";

export function registerSearchStrategyFlowOptions(command: Command): Command {
  return command
    .option("--search <intent>", "Run Wendao SearchStrategyFlow for a natural-language intent")
    .option("--wendao-graph <path>", "WendaoGraph.jl project path for --search")
    .option("--search-julia <command>", "Julia executable for --search")
    .option(
      "--search-backend <mode>",
      "SearchStrategyFlow backend: auto, rust-julia, or julia-direct",
    )
    .option("--search-rust-workspace <path>", "xiuxian Rust workspace for --search")
    .option("--search-rust-command <command>", "Cargo executable override for the Rust bridge")
    .option(
      "--search-rust-bridge-bin <path>",
      "Prebuilt wendaograph_search_strategy_flow binary for the Rust bridge",
    )
    .option(
      "--search-rust-bridge-session",
      "Run the Rust bridge through its JSONL stdio session protocol",
    )
    .option(
      "--search-flight-base-url <url>",
      "Studio Arrow Flight endpoint for Rust SearchStrategyFlow materialization",
    )
    .option(
      "--search-flight-timeout-seconds <seconds>",
      "Rust SearchStrategyFlow Flight request timeout",
      (value) => parseNonNegativeInt(value, "--search-flight-timeout-seconds"),
    )
    .option("--search-agent", "Run a live pi-subagents LLM judgement for LLM planner actions")
    .option(
      "--search-agent-answer-request <path>",
      "Read a materialized SearchStrategyFlow answer request TSV and write answer evidence",
    )
    .option("--search-agent-answer-mode <mode>", "Answer request mode: deterministic or live")
    .option(
      "--search-agent-answer-chunk-size <count>",
      "Live answer request chunk size",
      (value) => parseNonNegativeInt(value, "--search-agent-answer-chunk-size"),
    )
    .option(
      "--search-agent-answer-resume",
      "Resume live request answering from an existing evidence TSV prefix",
    )
    .option(
      "--search-agent-answer-evidence <path>",
      "Write completed --search-agent output as candidate_id<TAB>answer_text TSV evidence",
    )
    .option("--search-json", "Print raw SearchStrategyFlow JSON");
}
