# skillsc

Compile agent skills into BPMN 2.0 workflows with a large model, then execute them step-by-step with a small model.

## Install

```bash
npm install -g skillsc
```

## Usage

### Compile a skill

```bash
skillsc my-skill.md --model anthropic/claude-sonnet-4-20250514
```

This reads `my-skill.md`, sends it to the specified large model, and writes `my-skill.bpmn`.

Options:
- `-o, --output <file>` — output path (default: same name as input with `.bpmn` extension)
- `--model <model>` — model to use, as `provider/id` (required)
- `--provider <provider>` — LLM provider (alternative to `provider/id` format)
- `--api-key <key>` — API key (overrides environment variables)

### Execute a workflow

```bash
skillsx my-skill.bpmn --model openai/gpt-4o-mini
```

This parses the BPMN file, walks the process graph, and for each service task creates a scoped agent that prompts the small model with the task instructions.

Options:
- `--model <model>` — model to use for execution (required)
- `--provider <provider>` — LLM provider
- `--api-key <key>` — API key
- `--var key=value` — set workflow variables (repeatable)

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
skillsc review-skill.md --model anthropic/claude-sonnet-4-20250514

# 3. Edit the BPMN if needed (open in bpmn.io)

# 4. Execute with a small model
skillsx review-skill.bpmn --model openai/gpt-4o-mini
```

## How it works

### Compile phase

A large model reads the skill markdown and decomposes it into a BPMN 2.0 XML workflow. Each step becomes a `serviceTask` with:

- A focused prompt for the small model
- A list of tools the task needs (bash, read, edit, write, etc.)
- Input/output variable declarations for passing data between tasks
- Gateways for conditional logic
- Boundary error events for error handling

### Execute phase

The executor uses [bpmn-engine](https://github.com/paed01/bpmn-engine) to walk the BPMN graph. For each service task, it creates a scoped [pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core) `Agent` with:

- The task's prompt as the system prompt
- Only the tools the task needs
- Only the input variables the task declared
- Instructions to output declared variables as JSON

The small model only ever sees one focused task at a time.

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
    </skillsc:config>
  </extensionElements>
</serviceTask>
```

### Supported BPMN elements

| Element | Purpose |
|---------|---------|
| `startEvent` | Process entry point |
| `endEvent` | Process exit point |
| `serviceTask` | Task executed by the small model |
| `exclusiveGateway` | Conditional branching (XOR) |
| `parallelGateway` | Concurrent branches |
| `boundaryEvent` + `errorEventDefinition` | Error handling with fallback paths |
| `sequenceFlow` | Connects elements, with optional `conditionExpression` |

### Variables

Tasks declare input and output variables. Inputs are scoped — a task only sees the variables it declares. Outputs are extracted from the small model's response (as a JSON code block) and written to the workflow's variable store.

### Gateway conditions

Condition expressions use bpmn-engine's expression format:

```xml
<!-- Simple truthy check -->
<conditionExpression>${environment.variables.testsPassed}</conditionExpression>

<!-- Script-based comparison -->
<conditionExpression><![CDATA[
next(null, this.environment.variables.count > 5);
]]></conditionExpression>
```

Use the `default` attribute on `exclusiveGateway` for the fallback path.

## API keys

Set API keys via environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

Or pass directly with `--api-key`.

## Dependencies

- [@mariozechner/pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai) — LLM provider abstraction
- [@mariozechner/pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core) — Agent loop and tool execution
- [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) — Tool factories (read, bash, edit, write, etc.)
- [bpmn-engine](https://github.com/paed01/bpmn-engine) — BPMN 2.0 execution engine

## License

MIT
