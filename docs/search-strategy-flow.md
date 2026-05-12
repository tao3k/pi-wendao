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
   - `rust-code-intelligence-inventory` reads the configured structured
     candidate inventory for repository-scale search.
4. WendaoGraph.jl reduces the candidate graph into a compact frontier and
   planner actions. Candidate ids stay at Markdown section granularity, such as
   `docs/path.md#heading-anchor`.
   Required evidence from query understanding reserves selectable frontier
   branches before score-only filling. `ownership_boundary` maps to authority,
   `validation_path` maps to validation, `relation_path` maps to link graph,
   and `page_index_seed` maps to page index.
5. Rust maps selected candidates to Flight-native materialization routes:
   `/search/repos/main`,
   `/analysis/repo-projected-page-index-tree`,
   `/analysis/repo-projected-retrieval-context`, and `/graph/neighbors`.
6. `pi-wendao` renders the compact trace. If `--search-agent` is enabled, the
   LLM receives the graph evidence and planner actions rather than the whole
   source document.
7. If `--search-agent-answer-evidence <path>` is also provided, `pi-wendao`
   writes the completed live subagent output as
   `candidate_id<TAB>answer_text` TSV evidence for the WendaoGraph live answer
   rubric.

## Candidate Sources

The rendered trace includes `candidate_input_source` and
`candidate_input_count`. These fields are the handoff receipt between Rust and
the agent layer:

- `rust-markdown-headings` means the bridge used local section extraction. The
  route plan remains Flight-native, but materialization is expected to be
  `planned` unless a live service was configured.
- `rust-code-intelligence-inventory` means Rust used the configured
  code-intelligence structured candidate surface as the candidate source. With
  a live service, selected routes can still materialize through Flight and
  include row receipts.

## Agent Contract

The LLM and subagents should treat the graph trace as a pruning surface, not as
the final answer payload. A typical agent loop is:

1. rewrite, expand, classify, and route the intent using the
   `graph_query_understanding` rows;
2. check `validation.requiredEvidenceCovered`,
   `validation.selectedRequiredEvidence`, and
   `validation.missingRequiredEvidence` before accepting a frontier as
   answer-ready;
3. ask subagents to judge selected branches when planner actions require LLM
   judgement;
4. materialize only selected section-level candidates through Rust/Flight;
5. repeat the loop only when the planner action permits a refinement cycle.

This keeps the context window focused on the next reasoning-tree layer and
prevents the agent from spending tokens on unrelated full documents.

## Current Evaluation Status

The current live intent path has passed a repaired single-trace smoke: the
frontier covers authority, validation, and relation evidence before the live
model judgement, and the model judges that trace sufficient. This closes the
previous failure where the live judgement correctly rejected a frontier that
lacked direct ownership and validation evidence.

The separate materialized answer-evidence gate has also accepted a 128-row live
answer TSV with zero validation failures. That result proves the answer
contract at packet scale, but it is not a production promotion by itself. Full
promotion still requires broader configured-inventory precision labels,
required-evidence recall, false-positive control, and live sufficiency over a
stratified intent suite.

The stratified live intent suite is the next live batch contract. It covers
ownership boundary, validation path, relation bridge, page-index grounding,
blocked validation trap, implementation support, and registry metadata intents.
Normal tests validate the deterministic frontier and blocked-candidate contract;
live model execution remains opt-in and must still write the same
`candidate_id<TAB>answer_text` evidence shape.

The pi-wendao precision entry point is:

```bash
npm run test:search-precision
```

This command is only a wrapper around WendaoGraph's authoritative Julia gates:
materialized precision/recall, real-scenario inventory, and stratified
live-intent shape. `pi-wendao` does not compute precision itself; it produces
and validates agent evidence. Use `PI_WENDAO_WENDAOGRAPH_DIR` or
`--wendao-graph <path>` for a different checkout, and `--gate
materialized_precision` for the focused precision/recall gate.

The configured search denominator is the total structured candidate surface,
not only the local Markdown replay subset. Rust owns that structured search
surface and may query it through the backend index, including the configured
DuckDB-backed path. `pi-wendao` receives the narrowed SearchStrategyFlow trace;
it does not scan DuckDB, decode Arrow, or promote the `478` Markdown subset as
the full `2818`-candidate inventory.

## Live Answer Evidence Receipt

The live subagent output is still advisory until WendaoGraph validates it. Use
`--search-agent-answer-evidence <path>` with `--search-agent` to write the
receipt boundary explicitly:

```bash
npx --no-install pi-wendao --search "query understanding reasoning tree page index search strategy flow" \
  --wendao-graph ../WendaoGraph.jl \
  --search-root ../WendaoGraph.jl \
  --search-agent \
  --search-agent-answer-evidence ./search-strategy-flow-answer-evidence.tsv \
  --no-graph
```

The file format is:

```text
candidate_id	answer_text
docs/path.md#heading	candidate_id=docs/path.md#heading; ... judgement=...
```

`pi-wendao` writes one row per selected frontier candidate. It refuses to write
the file unless the live subagent completed and returned non-empty
`intent_understanding`, `branch_decision`, and `judgement` outputs. This keeps
the evidence path compatible with the WendaoGraph live answer rubric while
preserving the rule that the LLM does not own graph truth.

For the materialized scale gate, `pi-wendao` can also consume a request TSV
exported by WendaoGraph and write the same answer-evidence TSV format:

```bash
npx --no-install pi-wendao \
  --search-agent-answer-request ./search-strategy-flow-answer-request.tsv \
  --search-agent-answer-evidence ./search-strategy-flow-answer-evidence.tsv \
  --no-graph
```

This bridge is deterministic packet-contract evidence. It checks that the
request rows can become rubric-compatible answer rows, but it is not a live
Agent sufficiency result. A later live Agent job can use the same request TSV
as its input and write the same `candidate_id<TAB>answer_text` output shape.

Use `--search-agent-answer-mode live` with `--search-agent` to ask the
configured model to generate the request evidence:

```bash
npx --no-install pi-wendao \
  --search-agent \
  --search-agent-answer-request ./search-strategy-flow-answer-request.tsv \
  --search-agent-answer-mode live \
  --search-agent-answer-evidence ./search-strategy-flow-answer-evidence-live.tsv \
  --no-graph
```

Live mode accepts only strict TSV output from the model. The candidate ids must
match the request rows exactly, the row count must be complete, duplicate ids
are rejected, and each answer is bounded to the WendaoGraph evidence size
limit. Failed live output is not patched with deterministic packet evidence.
The parser only canonicalizes model transport escaping for literal quotes before
writing evidence. The live request job runs in chunks and reports accepted chunk
progress on stderr; use `--search-agent-answer-chunk-size <count>` to tune batch
size. Add `--search-agent-answer-resume` to continue from an existing evidence
TSV prefix; the existing rows must match the request rows exactly.

## Verification

Use the regular package checks:

```bash
npm run check
npx vitest run test/cli/search-strategy-flow-required-evidence.test.ts test/cli/pi-wendao-cli.test.ts
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
