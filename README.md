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
- `--trace-frame-ms <ms>` — delay between streamed graph trace frames
- `--model <model>` — accepted compatibility option for real host execution (defaults through `PI_WENDAO_MODEL` or Anthropic model environment variables when set)
- `--provider <provider>` — accepted compatibility option for model resolution
- `--api-key <key>` — accepted compatibility option for model resolution
- `--thinking <level>` — LLM thinking level for real host execution
- `-e, --extension <path>` — load an extra pi extension; built-in pi-subagents is already loaded from package dependencies
- `--var key=value` — set workflow variables (repeatable)
- `--show` — show qianji BPMN instances, or status plus graph snapshot for `--instance-id`, without executing the workflow
- `--tui` — enable interactive graph TUI visualization (default); without a workflow argument, open the LLM chat TUI
- `--no-tui` — disable interactive graph TUI visualization
- `--no-graph` — disable graph visualization (legacy alias for `--no-tui`)

Running `pi-wendao --tui` without a workflow opens the chat TUI. Type normally to
talk with the configured LLM. Use `/run <workflow.bpmn>` to execute a workflow
in the same TUI; the native chat stream stays primary, and the workflow graph
appears as a compact running panel below the chat stream. The graph viewport
follows the active BPMN node so the current task stays visible. Qianji trace
events, subagent lifecycle updates, tool calls, assistant replies, thinking,
and human/planner prompts stream through the normal chat roles: `agent>`,
`tool>`, `assistant>`,
`thinking>`, `system>`, and `user>`. Use `/show` or
`/show <instance> [bpmn]` to inspect qianji BPMN instances, `/help` for
commands, and `/quit` to exit.

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
- A list of tools the task needs (bash, read, edit, write, etc.)
- Input/output variable declarations for passing data between tasks
- Gateways for conditional logic, plus `businessRuleTask` for generated DMN decisions when needed
- Explicit fallback tasks and gateway paths for error handling

### Execute phase

The executor writes the BPMN source to qianji, then calls `qianji bpmn run`
with the selected process, instance id, context variables, optional DMN files,
and optional host/event fixtures. Qianji owns the BPMN runtime semantics,
including checkpoint backend selection; its local no-server default is DuckDB.
Qianji returns the final workflow variables.

When graph visualization is enabled, `pi-wendao` requests qianji trace streaming
and applies trace events in BPMN runtime order. A small default frame delay keeps
fast fixture-backed workflows visually progressive; set `--trace-frame-ms 0` or
`PI_WENDAO_TRACE_FRAME_MS=0` to disable pacing.
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
By default, these host calls use the packaged `pi-wendao-worker` pi-subagent type,
which allows the built-in `intercom` extension tool alongside the usual
read/write/search tools. Otherwise it falls back to the default
`pi-ai` service-task host.
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

The compiled output is valid BPMN 2.0 XML, loadable in [bpmn.io](https://bpmn.io/) or any BPMN editor. Extension elements use the `skillsc` namespace:

```xml
<serviceTask id="Task_1" name="Run tests"
             implementation="${environment.services.runAgent}">
  <extensionElements>
    <skillsc:config>
      <skillsc:prompt>Run the test suite and report results.</skillsc:prompt>
      <skillsc:tools>bash</skillsc:tools>
      <skillsc:inputs></skillsc:inputs>
      <skillsc:outputs>testsPassed</skillsc:outputs>
      <skillsc:agentType>pi-wendao-worker</skillsc:agentType>
      <skillsc:runInBackground>true</skillsc:runInBackground>
      <skillsc:maxTurns>8</skillsc:maxTurns>
    </skillsc:config>
  </extensionElements>
</serviceTask>
```

Human feedback or approval checkpoints use `userTask` with the same
`skillsc:config` fields. `skillsc:tools` must be empty because the graph TUI,
not an LLM tool runner, resolves the node:

```xml
<userTask id="Task_Approve" name="Approve proposal">
  <extensionElements>
    <skillsc:config>
      <skillsc:prompt>Review the proposal and approve before continuing.</skillsc:prompt>
      <skillsc:tools></skillsc:tools>
      <skillsc:inputs>proposal</skillsc:inputs>
      <skillsc:outputs>approved,approvedReply</skillsc:outputs>
    </skillsc:config>
  </extensionElements>
</userTask>
```

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
loading a second `intercom` provider. Under the default pi-ai host,
service tasks can declare `intercom` in `skillsc:tools`; under pi-subagents, the
child agent sees `intercom` through the `pi-wendao-worker` allowed tool set and
the native chat stream shows the call when the child agent uses it.
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

| Element | Purpose |
|---------|---------|
| `startEvent` | Process entry point |
| `endEvent` | Process exit point |
| `serviceTask` | Task executed by the small model |
| `userTask` | Graph-local human input, feedback, or approval checkpoint |
| `exclusiveGateway` | Conditional branching (XOR) |
| `parallelGateway` | Concurrent branches |
| `sequenceFlow` | Connects elements, with optional `conditionExpression` |

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
