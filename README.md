# pi-wendao

[![pi-wendao TUI demo](https://asciinema.org/a/tGOCniuej6UbkZBK.svg)](https://asciinema.org/a/tGOCniuej6UbkZBK)

Compile agent skills into qianji-owned BPMN 2.0 workflows, or BPMN+DMN
bundles, then run them through the `pi-wendao` TUI with qianji checkpoint,
parallel scheduling, graph trace, and pi-subagents host execution. The package
exposes one `pi-wendao` CLI. Use `pi-wendao compile` to compile skills and
`pi-wendao <workflow.bpmn>` to run workflows.

## Install

```bash
npm install -g pi-wendao
```

## Local Policy Checks

`pi-wendao` uses `typescript-lang-project-harness` as its TypeScript policy
gate. The policy is part of the normal check and test commands:

```bash
npm run check
npm test
```

Both commands run the TypeScript compiler or Vitest first, then enforce the
harness agent gate. Agent-facing findings are treated as required repair work,
and failures include the compact parser-owned owner map and finding groups.

To inspect the same surfaces directly:

```bash
npm run harness
npm run harness:agent
npm run harness:agent-gate
```

The package `Justfile` routes `just check` and `just test` through the same
policy-enforced commands, so `just verify-local` inherits the harness gate.

## Usage

### Compile a skill

```bash
pi-wendao compile my-skill.md --model anthropic/<model-id>
```

This reads `my-skill.md`, asks the large model whether the raw skill should compile to BPMN or BPMN+DMN, then fetches qianji's target-specific XML templates before generation. It writes `my-skill.bpmn`; if the model chooses BPMN+DMN, `pi-wendao compile` also writes `my-skill.dmn`.

Options:

- `-o, --output <file>` — output path (default: same name as input with `.bpmn` extension)
- `--model <model>` — model to use, as `provider/id` (required)
- `--provider <provider>` — LLM provider (alternative to `provider/id` format)
- `--api-key <key>` — API key (overrides environment variables)
- `--qianji <command>` — qianji CLI command used by template loading and compile-time lint
- `--lint-retries <count>` — repair attempts after qianji lint failure (default: 2)
- `--no-lint` — disable the compile-time qianji lint agent tool

### Execute a workflow

```bash
pi-wendao my-skill.bpmn
```

This delegates BPMN execution to `qianji bpmn run`. By default, `pi-wendao`
uses `QIANJI_CLI` when set, otherwise it resolves `qianji` from `PATH`.

For a BPMN+DMN compile result, pass the sidecar DMN source to qianji:

```bash
pi-wendao my-skill.bpmn --dmn my-skill.dmn
```

Options:

- `--process <id>` — BPMN process id (default: first process in the file)
- `--instance-id <id>` — qianji workflow instance id; must be a stable descriptive id, not a short numeric value
- `--qianji <command>` — qianji CLI command override
- `--dmn <path>` — pass a DMN source to qianji (repeatable)
- `--host-fixture <path>` — qianji host fixture JSON
- `--event-fixture <path>` — qianji event fixture JSON
- `--context-json <json>` — merge a JSON object after `--var` pairs
- `--trace-frame-ms <ms>` — optional delay between streamed graph trace frames
- `--model <model>` — accepted compatibility option for real host execution (defaults to `anthropic/deepseek-v4-pro`, with `PI_WENDAO_MODEL` and Anthropic-compatible environment variables overriding it)
- `--provider <provider>` — accepted compatibility option for model resolution
- `--api-key <key>` — accepted compatibility option for model resolution
- `--thinking <level>` — LLM thinking level for real host execution
- `-e, --extension <path>` — load an extra pi extension; built-in pi-subagents is already loaded from package dependencies
- `--var key=value` — set workflow variables (repeatable)
- `--show` — show qianji BPMN instances, or status plus graph snapshot for `--instance-id`, without executing the workflow
- `--tui` — enable interactive graph TUI visualization (default); without a workflow argument, open the native pi chat TUI
- `--no-tui` — disable interactive graph TUI visualization
- `--no-graph` — disable graph visualization (legacy alias for `--no-tui`)

### SearchStrategyFlow

```bash
npx --no-install pi-wendao --search "find the SearchStrategyFlow ownership boundary" --no-graph
```

Architecture details live in
[docs/search-strategy-flow.md](docs/search-strategy-flow.md).

`--search` is a pi-wendao CLI entry point for WendaoGraph SearchStrategyFlow
traces. The CLI discovers `WendaoGraph.jl`, asks Julia to score and prune graph
candidates, and prints Julia's graph-guided query-understanding evidence, the
frontier, planner actions, validation flags, and the planned LLM/subagent
judgement points. This path lives in this package so the agent-facing command
can evolve with pi-subagents instead of requiring users to call a Rust example
directly.
The rendered trace includes `strategy_budget`, which shows whether loop,
judgement, and beam budgets came from Julia query-understanding evidence or
from defaults.
It also includes `strategy_flow_stages`, a compact five-stage receipt aligned
with the WendaoGraph Pluto notebooks:

1. query understanding
2. candidate scoring
3. transition inference
4. frontier selection
5. planner actions

Those stage receipts make the CLI trace match the research notebooks and give
pi-subagents a bounded reasoning-tree surface instead of a flat search result.
Candidate ids use Markdown section granularity, for example
`docs/30_search_strategy/30.01_search_strategy_flow.md#stage-1-query-understanding`,
so the first materialization layer can reveal the content under the selected
heading instead of handing the agent a whole Markdown file.
The rendered trace also includes `retrieval_routes`, a derived route plan that
maps selected section candidates to Rust-owned materialization surfaces and
marks direct file reads as disallowed. The primary route plan is Arrow
Flight-native: first search through `/search/repos/main`, then resolve the
heading through `/analysis/repo-projected-page-index-tree`, then open the
section retrieval context through
`/analysis/repo-projected-retrieval-context`, then expand extra relations
through `/graph/neighbors`. There is no Studio HTTP fallback in this plan: if
the Flight path cannot materialize the section, the retrieval layer must report
a Flight/Rust failure instead of bypassing the primary contract. The heading
anchor is not treated as a stable `node_id`; Rust owns that resolution. The
page-index section node and the link-graph document node are separate
namespaces, so graph expansion uses `resolvedGraphNodeId` rather than the
section-level `resolvedNodeId`.
Route entries are marked `materialization=planned` when `pi-wendao` derives
the route plan locally, which is the expected `julia-direct` smoke-test shape.
The Rust bridge also returns planned Studio Flight routes by default. It must
only return `materialization=executed` when it has connected to a real Flight
service endpoint and decoded the route batches. Agent answer generation must
treat `execute_before_answer=yes` as a hard guard unless Rust has returned
executed Arrow Flight evidence for the requested section.
`pi-wendao` forwards endpoint settings to the Rust bridge and renders the
returned evidence; it does not decode Arrow Flight streams with JS Arrow.
Required evidence is enforced before live Agent judgement. When Julia infers
`ownership_boundary`, `validation_path`, `relation_path`, or `page_index_seed`,
the frontier reserves matching authority, validation, link-graph, or page-index
branches before score-only filling. The rendered validation block reports
`required_evidence_covered`, `selected_required_evidence`, and
`missing_required_evidence`; the Agent receives the same coverage in its compact
trace.

Options:

- `--wendao-graph <path>` — explicit `WendaoGraph.jl` project path
- `--search-root <path>` — knowledge root used for candidate context-cost evidence
- `--search-julia <command>` — Julia executable override
- `--search-backend <mode>` — `auto`, `rust-julia`, or `julia-direct`
- `--search-rust-workspace <path>` — optional xiuxian Rust workspace for the Rust bridge
- `--search-rust-command <command>` — Cargo executable override for the Rust bridge
- `--search-flight-base-url <url>` — Studio Arrow Flight endpoint consumed by the Rust bridge
- `--search-flight-repo <repo>` — Wendao repo id for native Flight route execution
- `--search-flight-timeout-seconds <seconds>` — Rust bridge Flight request timeout
- `--search-agent` — run a live pi-subagents LLM judgement for planner actions that require an LLM
- `--search-agent-answer-request <path>` — read a WendaoGraph materialized answer request TSV and write deterministic packet-contract answer evidence
- `--search-agent-answer-mode <mode>` — answer request mode, either `deterministic` or `live`
- `--search-agent-answer-chunk-size <count>` — live answer request chunk size; defaults to a small batch for progress visibility
- `--search-agent-answer-resume` — continue live request answering from an existing evidence TSV prefix
- `--search-agent-answer-evidence <path>` — with `--search-agent`, write completed live agent output as `candidate_id<TAB>answer_text` TSV evidence for the WendaoGraph live answer rubric
- `--search-json` — print the structured trace JSON

The default `auto` backend treats the Rust-to-Julia bridge as the core path. It
requires a xiuxian Rust workspace and fails if the Rust bridge is unavailable or
broken, because pi-wendao should not silently bypass the Rust control plane.
Use `--search-backend julia-direct` only for pi-local bridge smoke tests and
diagnostics.

The production subagent retrieval path should remain Flight/Rust-owned:
`pi-wendao` receives the intent and agent trace, the Flight service owns stable
Arrow routes such as `/search/intent`, `/search/knowledge`,
`/search/repos/main`, `/graph/neighbors`, and
`/analysis/repo-projected-page-index-tree`, and
`/analysis/repo-projected-retrieval-context`. SearchStrategyFlow section
candidate ids are therefore routing evidence for Flight retrieval, not a
license for pi-wendao to bypass the Rust boundary and read full Markdown files.

For the default DeepSeek model through the Anthropic-compatible API:

```bash
export DEEPSEEK_API_KEY=...
npx --no-install pi-wendao --search "find the relevant knowledge boundary" --search-agent --no-graph
```

`pi-wendao` defaults SearchStrategyFlow agent calls to
`anthropic/deepseek-v4-pro` and uses DeepSeek's Anthropic-compatible endpoint
for that model. It also honors the documented gateway variables when set:
`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` plus
`ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY`.

The live DeepSeek algorithm smoke is opt-in so regular CI does not depend on
network or paid model access:

```bash
npm run test:search-live
```

That test uses `--search-backend julia-direct` intentionally: it validates that
the graph-owned SearchStrategyFlow algorithm trace and the first-layer
`SearchStrategyFlow_QueryUnderstanding` LLM judgement are complete without
paying the Rust bridge startup and compilation cost on every algorithm smoke.
It expects `DEEPSEEK_API_KEY` in the worktree `.env` and requires the
first-layer understanding agent to stay tool-less (`Tool uses: 0`). Expansion
agents that read candidate documents belong to the next reasoning-tree layer.

To produce an auditable answer-evidence receipt for WendaoGraph validation,
write the live subagent output to an explicit TSV path:

```bash
npx --no-install pi-wendao --search "find the relevant knowledge boundary" \
  --search-agent \
  --search-agent-answer-evidence ./search-strategy-flow-answer-evidence.tsv \
  --no-graph
```

The receipt is written only after the live subagent completes with non-empty
`intent_understanding`, `branch_decision`, and `judgement` outputs. It emits one
row per selected frontier candidate using the fixed
`candidate_id<TAB>answer_text` contract. The receipt is input evidence for the
WendaoGraph live answer rubric; it is not a production promotion by itself.

For the materialized 128-row scale gate, use a WendaoGraph request TSV as the
input and write the same evidence shape:

```bash
npx --no-install pi-wendao \
  --search-agent-answer-request ./search-strategy-flow-answer-request.tsv \
  --search-agent-answer-evidence ./search-strategy-flow-answer-evidence.tsv \
  --no-graph
```

This mode is deterministic packet-contract evidence, not a live model run. It
exists so the scale gate can validate row identity and rubric coverage before a
separate live Agent job spends model budget.

To run the same request surface through a live model, add
`--search-agent-answer-mode live` and `--search-agent`:

```bash
npx --no-install pi-wendao \
  --search-agent \
  --search-agent-answer-request ./search-strategy-flow-answer-request.tsv \
  --search-agent-answer-mode live \
  --search-agent-answer-evidence ./search-strategy-flow-answer-evidence-live.tsv \
  --no-graph
```

Live mode rejects missing rows, duplicate candidate ids, empty answers,
malformed TSV, and answers over the WendaoGraph evidence-size bound. It does
not fill gaps with deterministic packet evidence. The parser only canonicalizes
model transport escaping for literal quotes before writing evidence. The live
request job runs in chunks and prints accepted chunk progress to stderr so long
runs do not look like a black-box stall. Use `--search-agent-answer-resume`
after an interrupted run; the existing evidence rows must be a valid prefix of
the request rows.

Use the slower bridge smoke only when validating the Rust-owned host-process
proof surface:

```bash
npm run test:search-bridge-smoke
```

That smoke verifies `pi-wendao -> Rust bridge CLI proof -> WendaoGraph.jl` and
requires the default backend to report `rust-wendao-julia` with no fallback.
The bridge smoke does not claim to be the full service-backed production
materialization chain unless those receipts are produced by the running Rust
service boundary over Arrow Flight.

The full bridge integration gate is a separate, slower layer: it must start the
Rust service side and the Julia compute service, wait for readiness/prewarm, and
then drive SearchStrategyFlow through the running service boundary. That gate
belongs with the Rust/Juila service orchestration contract, not with the fast
algorithm smoke. First-layer query understanding and judgement keep the
configured reasoning level because route selection is correctness-sensitive;
latency work must come from orchestration, caching, compact traces, and later
branch-level parallelism instead of weakening the first decision. The prompt
receives the `graph_query_understanding` trace section as hard graph evidence:
route hints, required evidence, ambiguity, and the applied loop/judgement/beam
budgets.

Running `pi-wendao --tui` without a workflow enters pi's native interactive
session for the current working directory. Type normally to talk with the
configured LLM; pi owns session persistence, history scrolling, `/session`,
`/resume`, `/tree`, compaction, tool rendering, and extension UI. Use
`/run <workflow.bpmn>` to execute a qianji BPMN workflow in that same session.
Use `/run brainstorm` to run the built-in brainstorming named workflow; see
[docs/named-workflows.md](docs/named-workflows.md) for cache and seed behavior.
The workflow graph is a pi extension widget above the editor, and qianji trace
events, subagent lifecycle updates, tool calls, assistant replies, thinking, and
human/planner prompts are written as pi custom messages. Use `/show` or
`/show <instance> [bpmn]` to inspect qianji BPMN instances. Qianji still owns
BPMN progression, parallel branches, checkpoints, retry, resume, and instance
state; the pi layer only provides native chat/session/UI integration.

### Example workflow

```bash
# 1. Write a skill
cat > review-skill.md << 'EOF'
# Code Review Skill
Review the current project for common issues.

## Steps
1. List all source files
2. Read each file
3. Check for common issues (unused imports, missing error handling)
4. Report findings
EOF

# 2. Compile with a large model
pi-wendao compile review-skill.md --model anthropic/<model-id>

# 3. Edit the BPMN if needed (open in bpmn.io)

# 4. Execute through qianji
pi-wendao review-skill.bpmn
```

## How it works

### Compile phase

Compile sends the raw `SKILL.md` to the large model for target selection: BPMN for procedural workflow, or BPMN+DMN when the skill contains stable deterministic decision-table logic. Pure DMN is normalized to BPMN+DMN because pi-wendao execution still needs a BPMN workflow. After target selection, `pi-wendao compile` calls `qianji template --bpmn` and, when needed, `qianji template --dmn`, then gives those lint-clean templates to the compile agent as the XML skeleton. Compile then runs as an agent loop with an internal `qianji_lint` tool. The model must lint the generated BPMN and, when present, the generated DMN, repair from qianji lint feedback, and return only XML after qianji lint passes.

Each step becomes a `serviceTask` with:

- A focused prompt for the small model
- Native BPMN input/output variable declarations for passing data between tasks
- Gateways for conditional logic, plus `businessRuleTask` for generated DMN decisions when needed
- Explicit fallback tasks and gateway paths for error handling

### Execute phase

The executor writes the BPMN source to qianji, then calls `qianji bpmn run`
with the selected process, instance id, context variables, optional DMN files,
and optional host/event fixtures. Qianji owns the BPMN runtime semantics,
including checkpoint backend selection; its local no-server default is DuckDB.
Qianji returns the final workflow variables.

When graph visualization is enabled, `pi-wendao` requests qianji trace streaming
and applies trace events in BPMN runtime order. Trace pacing is opt-in; set
`--trace-frame-ms <ms>` or `PI_WENDAO_TRACE_FRAME_MS=<ms>` only when animated
replay is needed.
When execution stops at qianji host work, the active task node also shows
runtime details such as host token count, host backend, checkpoint backend and
source, and declared subagent type. These details are graph annotations only;
qianji trace events still own graph progression.
For pi-subagents-backed host work, `pi-wendao` also requests verbose subagent
results and mirrors the subagent lifecycle plus the verbose child conversation
into the native chat stream. The child conversation preserves user prompts,
assistant replies, tool calls with their arguments, and tool-result summaries as
separate chat roles instead of flattening them into a generic tool log. Live
host-work batches are also logged explicitly; when qianji exposes more than one
pending host token, the chat/log stream emits a line such as
`parallel jobs Task_Review: 2 jobs tokens=11,12`, making the actual parallel
fan-out visible from qianji's scheduler output.
Live subagent updates also annotate the active BPMN task node with compact details,
such as `llm:thinking` or `tool:bash "find . -name \"*.ts\""`, so graph mode
shows the current host-side LLM/tool state without moving graph progression out
of qianji. qianji trace events still remain the source of BPMN node and edge
progression.
When `--instance-id` is supplied, `pi-wendao` first asks qianji for the checkpoint
status using the BPMN file as graph context, then hydrates the graph from that
snapshot before resuming execution.

When real host execution is enabled, qianji still owns BPMN token scheduling,
parallel gateways, joins, and checkpoint state. `pi-wendao` dispatches each
pending service-task token through a `PiWendaoAgentHost` backend and returns the
token-scoped output fixture to qianji. `pi-wendao` loads the packaged
pi-subagents extension and its own graph-local intercom extension by default,
then uses pi-subagents `Agent` and `get_subagent_result` tools as the host
backend when available.
Planner and user prompts inside the native TUI use the `pi-ask` package as an
internal UI dependency; `pi-ask` is not loaded as a pi extension and does not
register an `ask_user` tool into the workflow session.
The pi-subagents backend resolves worker capability from the host profile and
task prompt. Native BPMN IO declares workflow data only; it does not grant
workspace tools by itself.
The graph-local intercom bridge is exposed as the `intercom` tool in the active
pi extension context; graph mode logs `Extension tool: pi-intercom` at startup
and shows actual calls as compact details such as `tool:intercom action=status`
only when an LLM invokes the tool. When a pi-subagents worker calls
`intercom({ action: "ask", to: "planner", message: "..." })`, the chat stream
opens an inline prompt; pressing Enter submits the
planner approval or clarification and unblocks the worker tool call.
For workflow-owned human checkpoints, compile or write an explicit BPMN
`userTask` instead. When qianji blocks on that `userTask`, graph mode opens an
inline `user>` prompt, maps approval-like outputs such as `approved` to boolean
values, preserves text outputs such as `approvedReply` or `feedback`, and
returns the result to qianji through the normal host-completion path. This keeps
human approval in BPMN instead of making a subagent guess whether to continue.
Each host request receives read-only qianji execution feedback: process id,
instance id, BPMN activity id, token id, multi-instance repeat metadata, and
checkpoint report fields such as backend, source, status, and pending host
work. This context lets a subagent self-direct inside the current task node
while qianji remains the only BPMN scheduler and checkpoint owner.
`pi-wendao` does not synthesize gateway decisions, retry counters, or task outputs
from service-task prompt text. Host outputs are returned to qianji as the
token-scoped completion fixture; qianji then evaluates BPMN conditions, retries,
parallel joins, checkpoints, and resume state.

When no `--host-fixture` is provided and no real host is active, `pi-wendao`
derives a temporary qianji host fixture for pi-wendao host tasks from their
declared output names. This keeps generated workflows runnable through the
qianji CLI while preserving explicit `--host-fixture` as the override for
deterministic host data.

## BPMN format

The compiled output is valid BPMN 2.0 XML, loadable in [bpmn.io](https://bpmn.io/)
or any BPMN editor without a custom moddle descriptor. See
[docs/bpmn-format.md](docs/bpmn-format.md) for the maintained native XML
contract, including human-task interaction metadata based on standard BPMN IO.

The `agentType`, `runInBackground`, `maxTurns`, `agentModel`, `thinking`,
`isolated`, `isolation`, and `inheritContext` fields are optional execution
metadata for subagent-capable host backends. They do not alter BPMN graph
progression; qianji still decides the next node from BPMN state and returned
variables.

Subagent-capable hosts should persist their own run records separately from
qianji's BPMN checkpoint. `pi-wendao` exposes a `PiSubagentsRunStore` adapter
boundary for this purpose: store the subagent id immediately after spawn, keyed
by qianji instance id, token id, BPMN activity id, and the current task input
snapshot, then reuse that id on resume instead of spawning duplicate work. The
input snapshot keeps retry loops and repeated activity visits from reusing stale
host output. This is host recovery metadata, not a qianji checkpoint mode or CLI
flag.

Inter-session coordination follows the same ownership rule. The executor
provides a `PiWendaoIntercomCorrelationState` boundary for `send`, `ask`,
`reply`, and `pending` message state inspired by pi-intercom. Records are keyed
by qianji instance id, activity id, token id, and message id when BPMN execution
metadata is available. This lets a host adapter attach direct-message or
question/reply metadata to a BPMN token without deciding graph progression.
When loaded pi extensions provide the pi-intercom `intercom` tool, lower-level
callers can use `createPiIntercomClientFromLoadedExtensions(...)` or
`tryCreatePiIntercomClientFromLoadedExtensions(...)` to execute
`list/send/ask/reply/pending/status` actions and optionally mirror message
state into `PiWendaoIntercomCorrelationState`. `pi-wendao` exposes project
`.pi/extensions` and `.pi/agents/pi-wendao-worker.md` wrappers so pi-subagents
child sessions can load the graph-local `intercom` tool surface without also
loading a second `intercom` provider. Under pi-subagents, the child agent sees
`intercom` through the `pi-wendao-worker` allowed tool set and the native chat
stream shows the call when the child agent uses it.
Graph-local `ask` calls target the inline planner inbox; `send` calls are
fire-and-forget chat messages.
CLI execution resolves workflow, fixture, DMN, and explicit extension paths
before switching pi extension discovery to the packaged pi-wendao root, so qianji
still runs from the original launch directory while pi-subagents consistently
finds the packaged `.pi` resources.

Plain `npx pi-wendao` loads built-in pi-wendao pi packages, configured pi packages,
and explicit `--extension` paths during model resolution. It automatically
injects the pi-subagents host when those tools are available. A separate pi
runtime wrapper can also call
`executeBpmnWithPiSubagents(...)` with the BPMN path, loaded extension result,
active pi `ExtensionContext`, qianji command options, and either a
`PiSubagentsRunStore` or JSON store path. The helper constructs the
checkpoint-aware host and executes the BPMN through qianji. Lower-level callers
can use `createPiSubagentsHostFromLoadedExtensions(...)` when they want to
inject a host directly, `discoverPiSubagentsHost(...)` when they need extension
discovery plus host construction, or
`createPiSubagentsClientFromLoadedExtensions(...)` when they want to assemble
the host manually.

### Supported BPMN elements

| Element            | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `startEvent`       | Process entry point                                       |
| `endEvent`         | Process exit point                                        |
| `serviceTask`      | Task executed by the small model                          |
| `userTask`         | Graph-local human input, feedback, or approval checkpoint |
| `exclusiveGateway` | Conditional branching (XOR)                               |
| `parallelGateway`  | Concurrent branches                                       |
| `sequenceFlow`     | Connects elements, with optional `conditionExpression`    |

### Variables

Tasks declare input and output variables. Inputs are scoped — a task only sees the variables it declares. Outputs are extracted from the small model's response (as a JSON code block) and written to the workflow's variable store.

### Gateway conditions

Condition expressions use qianji's bounded expression format:

```xml
<!-- Simple truthy check -->
<conditionExpression>testsPassed</conditionExpression>

<!-- Numeric comparison -->
<conditionExpression>count > 5</conditionExpression>
```

Use the `default` attribute on `exclusiveGateway` for the fallback path.

## API keys

Set API keys via environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

For Claude-compatible gateways, `pi-wendao compile` also honors:

```bash
export ANTHROPIC_BASE_URL=https://your-anthropic-compatible-gateway
export ANTHROPIC_AUTH_TOKEN=...
pi-wendao compile my-skill.md --model anthropic/your-gateway-model
```

Or pass directly with `--api-key`.

## Dependencies

- [@mariozechner/pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai) — LLM provider abstraction
- [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) — Tool factories (read, bash, edit, write, etc.)
- [fast-xml-parser](https://www.npmjs.com/package/fast-xml-parser) — BPMN process id discovery
- `qianji template` — compile-time BPMN/DMN skeletons for model generation
- `qianji lint` — compile-time BPMN and DMN validation
- `qianji bpmn run` — BPMN execution engine

## License

MIT
