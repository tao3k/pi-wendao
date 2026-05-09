# SearchStrategyFlow Rust Bridge

SearchStrategyFlow turns one natural-language intent into a bounded,
section-level reasoning trace. The production path is not a local Markdown file
reader. It is a Rust-controlled bridge into WendaoGraph.jl, with Rust-owned
Flight retrieval routes for materialization.

## Runtime Roles

- `pi-wendao` owns the agent-facing CLI, optional live LLM judgement, and
  subagent interaction rendering.
- The xiuxian Rust bridge owns the control plane: candidate-source selection,
  process launch, Flight endpoint configuration, route receipts, and failure
  boundaries.
- WendaoGraph.jl owns the graph algorithm: query understanding, candidate
  scoring, transition inference, frontier selection, and planner actions.
- Studio Flight owns section materialization. JavaScript does not decode Arrow
  Flight streams and does not read full Markdown files as a fallback.

## Flow

1. The user passes an intent through `pi-wendao --search "<intent>"`.
2. `pi-wendao` defaults to the Rust bridge in `auto` mode. `julia-direct` is
   reserved for pi-local algorithm smoke tests.
3. Rust builds a candidate input batch before calling WendaoGraph.jl:
   - `rust-markdown-headings` scans Markdown headings for local smoke tests.
   - `rust-flight-repo-search` queries `/search/repos/main` when a Flight
     endpoint and repo id are configured.
4. WendaoGraph.jl reduces the candidate graph into a compact frontier and
   planner actions. Candidate ids stay at Markdown section granularity, such as
   `docs/path.md#heading-anchor`.
5. Rust maps selected candidates to Flight-native materialization routes:
   `/search/repos/main`,
   `/analysis/repo-projected-page-index-tree`,
   `/analysis/repo-projected-retrieval-context`, and `/graph/neighbors`.
6. `pi-wendao` renders the compact trace. If `--search-agent` is enabled, the
   LLM receives the graph evidence and planner actions rather than the whole
   source document.

## Candidate Sources

The rendered trace includes `candidate_input_source` and
`candidate_input_count`. These fields are the handoff receipt between Rust and
the agent layer:

- `rust-markdown-headings` means the bridge used local section extraction. The
  route plan remains Flight-native, but materialization is expected to be
  `planned` unless a live service was configured.
- `rust-flight-repo-search` means Rust used the repo search Flight route as the
  candidate source. With a live service, selected routes can be
  `materialization=executed` and include row receipts.

## Agent Contract

The LLM and subagents should treat the graph trace as a pruning surface, not as
the final answer payload. A typical agent loop is:

1. rewrite, expand, classify, and route the intent using the
   `graph_query_understanding` rows;
2. ask subagents to judge selected branches when planner actions require LLM
   judgement;
3. materialize only selected section-level candidates through Rust/Flight;
4. repeat the loop only when the planner action permits a refinement cycle.

This keeps the context window focused on the next reasoning-tree layer and
prevents the agent from spending tokens on unrelated full documents.

## Verification

Use the regular package checks:

```bash
npm run check
npx vitest run test/cli/pi-wendao-cli.test.ts -t "Rust SearchStrategyFlow bridge|Flight endpoint settings"
```

Use a local smoke for the Rust bridge without requiring a live Flight service:

```bash
npx --no-install pi-wendao --search "query understanding reasoning tree page index search strategy flow" \
  --wendao-graph ../WendaoGraph.jl \
  --search-root ../WendaoGraph.jl \
  --search-rust-workspace ../.. \
  --no-graph
```

That smoke should report `backend: rust-wendao-julia`,
`candidate_input_source: rust-markdown-headings`, and planned Flight routes.
