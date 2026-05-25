# SearchStrategyFlow Rust Bridge

SearchStrategyFlow turns one natural-language intent into a bounded,
section-level reasoning trace. The production path is not a local Markdown file
reader. It is a Rust-controlled bridge into WendaoGraph.jl, with Rust-owned
Flight retrieval routes for materialization.

## Runtime Roles

- `pi-wendao` owns the agent-facing CLI, optional live Qianji service-agent
  judgement, and trace rendering.
- The query-understanding service agent owns the intent-to-required-evidence
  handoff. It decides what the graph must prove before any backend route is
  worth executing.
- The xiuxian Rust bridge owns the control plane: candidate-source selection,
  process launch, Flight endpoint configuration, route receipts, and failure
  boundaries.
- WendaoGraph.jl owns the graph algorithm: query understanding, candidate
  scoring, transition inference, frontier selection, and planner actions.
- The WendaoGraph SearchStrategyFlow Arrow Flight service owns production
  algorithm execution when `--search-strategy-flow-service-base-url` is set.
  The Rust bridge reaches that service through the shared polyglot admission
  and Arrow Flight client path; `pi-wendao` only supplies a process-control
  envelope.
- Studio Flight owns section materialization. JavaScript owns a narrow raw
  Arrow table decode boundary for backend-returned tables, while Gateway/Rust
  owns live Flight routing. JavaScript does not read full Markdown files as a
  fallback, and it must not carry Arrow payloads through JSON/base64 wrappers.
  Reports use `arrow-flight` for table data, `none` when no backend data plane
  is present, and `jsonl-stdio-control`/`process-args-control` for control-only
  coordination.

## Flow

1. The user passes an intent through `pi-wendao --search "<intent>"`.
2. `pi-wendao` defaults to the Rust bridge in `auto` mode. `julia-direct` is
   reserved for pi-local algorithm smoke tests.
3. Rust builds a candidate input batch before calling WendaoGraph.jl or its
   SearchStrategyFlow Arrow Flight service:
   - `rust-markdown-headings` scans Markdown headings for local smoke tests.
   - `rust-code-intelligence-inventory` reads the configured structured
     candidate inventory for repository-scale search.
4. WendaoGraph.jl reduces the candidate graph into a compact frontier and
   planner actions. In service mode, the response bundle returns the
   `strategy_candidates`, `strategy_transitions`, `strategy_frontier`, and
   `strategy_planner_actions` tables as Arrow IPC payloads. Candidate ids stay
   at Markdown section granularity, such as `docs/path.md#heading-anchor`.
   Required evidence from query understanding reserves selectable frontier
   branches before score-only filling. `ownership_boundary` maps to authority,
   `validation_path` maps to validation, `relation_path` maps to link graph,
   and `page_index_seed` maps to page index.
5. Rust maps selected candidates to backend materialization routes. This is the
   correct place to call Gateway REST/Flight data-plane surfaces: after
   `pi-wendao` query understanding and WendaoGraph.jl frontier selection, not
   as a public `/api/search/strategy-flow` intent route.
   `/search/repos/main`,
   `/analysis/repo-projected-page-index-tree`,
   `/analysis/repo-projected-retrieval-context`, and `/graph/neighbors`.
6. `pi-wendao` renders the compact trace. If `--search-agent` is enabled, the
   LLM receives the graph evidence and planner actions rather than the whole
   source document.
7. If `--search-agent-answer-evidence <path>` is also provided, `pi-wendao`
   writes the completed live Qianji service-agent output as
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

The LLM-backed Qianji service agents should treat the graph trace as a pruning
surface, not as the final answer payload. A typical agent loop is:

1. rewrite, expand, classify, and route the intent using the
   `graph_query_understanding` rows;
2. check `validation.requiredEvidenceCovered`,
   `validation.selectedRequiredEvidence`, and
   `validation.missingRequiredEvidence` before accepting a frontier as
   answer-ready;
3. ask Qianji service agents to judge selected branches when planner actions
   require LLM judgement;
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
DuckDB-backed path. `pi-wendao` receives the narrowed SearchStrategyFlow trace
and decodes only explicit Arrow IPC tables handed across the bridge contract;
it does not scan DuckDB or promote the `478` Markdown subset as the full
`2818`-candidate inventory.

When a live Agent supplies a second frontier pass, `pi-wendao` writes the
first-pass `queryUnderstanding` rows and accepted `branch_judgements` rows as
Arrow IPC files and passes only control-path pointers to the Rust bridge. The
JSONL bridge session uses `queryUnderstandingArrowIpcPath` and
`branchJudgementsArrowIpcPath`; table rows are not embedded in JSON and are not
serialized as a delimited-text public interface.

For production algorithm execution, pass
`--search-strategy-flow-service-base-url <url>` to the CLI or set
`PI_WENDAO_SEARCH_STRATEGY_FLOW_SERVICE_BASE_URL`. This cannot be combined with
`--search-rust-bridge-session`: the service path uses process args only as
control and carries graph tables over Arrow Flight. A benchmark row is
promotion-eligible only when the trace reports `strategyFlowDataPlane` as
`arrow-flight` and at least one selected retrieval route has executed through
Studio/Gateway Flight.

The live Markdown corpus benchmark keeps live agent retries explicit. It
retries only timeout failures, runs retry attempts serially after the initial
bounded-concurrency pass, and never retries rows whose deterministic Rust/Julia
trace already failed backend, required-evidence, expected-source, or
blocked-source gates. `--live-agent-retries <count>` sets the retry limit and
defaults to one retry. `--live-agent-retry-timeout-seconds <seconds>` can tune
the retry timeout without changing the first-attempt timeout.

The same benchmark defaults live agent candidate-pool handling to `auto`. When
the deterministic graph gate already covers required evidence, the Qianji
judgement receives only selected/actionable frontier branches; this avoids
spending model time judging rescue candidates that cannot improve a covered
frontier. When required evidence is missing, candidate-pool rows remain visible
so the live judgement can still recommend a high-confidence expansion. Use
`--live-agent-candidate-pool visible` to force the wider trace, or
`--live-agent-candidate-pool selected-only` to force the narrow trace. Reports
include `liveRetriedCount`, `liveRetryRecoveredCount`,
`totalLiveAttemptCount`, `liveAgentMode`, `liveAgentCandidatePoolMode`, and
per-row live attempt/retry counts so model-side stalls are visible instead of
being mixed with Gateway or graph latency.

The benchmark also supports `--live-agent-mode batch-judgement` with
`--live-agent-batch-size <count>`. Batch judgement sends several deterministic
pass rows to one Qianji BPMN service-agent task and then validates each
returned family independently against its exact frontier ids. This mode is only
for live benchmark calling-shape experiments. It does not replace Arrow Flight
as the Rust/Julia data plane, and rows with deterministic gate failures are
skipped before any live model call. Reports include `liveBatchCount`,
`totalLiveBatchDurationMs`, and `maxLiveBatchDurationMs`.

Use `--live-agent-mode batch-sufficiency` when the benchmark only needs a live
family-level sufficiency gate after deterministic graph coverage has passed.
This mode asks Qianji to return one JSON sufficiency row per intent family
instead of branch-level judgements. Missing, duplicate, or unexpected family ids
are rejected, and rejected rows remain failed benchmark rows. This keeps the
LLM as a lightweight judge while leaving frontier selection, required-evidence
coverage, and Arrow Flight materialization deterministic.

## Live Answer Evidence Receipt

The live Qianji service-agent output is structured before it can affect graph selection.
`pi-wendao` requires `branch_judgements` rows keyed by exact frontier candidate
ids, validates each row, and feeds accepted rows back into WendaoGraph as the
generic `branch_judgements` table for a second frontier pass. Natural-language
`branch_decision` text is rendered for humans only.

Use `--search-agent-answer-evidence <path>` with `--search-agent` to write the
receipt boundary explicitly:

```bash
npx --no-install pi-wendao --search "query understanding reasoning tree page index search strategy flow" \
  --wendao-graph ../WendaoGraph.jl \
  --search-agent \
  --search-agent-answer-evidence ./search-strategy-flow-answer-evidence.tsv \
  --no-graph
```

The file format is:

```text
candidate_id	answer_text
docs/path.md#heading	candidate_id=docs/path.md#heading; ... judgement=...
```

`pi-wendao` writes one row per selected frontier candidate from the graph trace
after accepted branch judgements have been applied. It refuses to write the file
unless the live Qianji service agent completed with non-empty `intent_understanding`,
`branch_decision`, `judgement`, and valid `branch_judgements` outputs. This
keeps the evidence path compatible with the WendaoGraph live answer rubric while
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
  --search-rust-workspace ../.. \
  --no-graph
```

That smoke should report `backend: rust-wendao-julia`,
`candidate_input_source: rust-markdown-headings`, and planned Flight routes.

For benchmark runs that should exclude cargo startup, build the Rust binary
once and pass it directly:

```bash
npx --no-install pi-wendao --search "query understanding reasoning tree page index search strategy flow" \
  --wendao-graph ../WendaoGraph.jl \
  --search-rust-workspace ../.. \
  --search-rust-bridge-bin ../../target/debug/wendaograph_search_strategy_flow \
  --no-graph
```

The direct-binary path uses the same Rust bridge and Flight route contract as
cargo mode. It only changes process launch shape: `pi-wendao` invokes the
prebuilt bridge with native bridge arguments rather than `cargo run ... --bin
wendaograph_search_strategy_flow -- ...`.

For single-intent runs that should use the Rust bridge JSONL control session
protocol, enable the explicit session flag. A Flight endpoint is optional; when
it is absent, the bridge returns planned route receipts from local Markdown
candidate discovery:

```bash
npx --no-install pi-wendao --search "query understanding reasoning tree page index search strategy flow" \
  --wendao-graph ../WendaoGraph.jl \
  --search-rust-workspace ../.. \
  --search-rust-bridge-bin ../../target/debug/wendaograph_search_strategy_flow \
  --search-rust-bridge-session \
  --no-graph
```

The session flag calls the bridge with `--serve-stdio` and sends the intent as a
JSONL control request. Add `--search-flight-base-url http://127.0.0.1:50052`
when route materialization should execute through Studio/Gateway Flight. The
CLI closes the session after the command completes; the Markdown corpus
benchmark keeps one session process open for all intent rows to avoid repeated
Julia host warmup. The benchmark report records bridge-session request count,
session duration, first response latency, response span, max response gap,
total route materialization time, and max route materialization time so fixed
startup cost is not mistaken for Flight route latency or per-intent algorithm
latency.
Evidence tables stay on the Arrow Flight data plane when Flight is configured;
JSONL is not a replacement transport for candidate or evidence rows. The
session token is `jsonl-stdio-control`; it is never a table payload token.
