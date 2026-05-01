# Dynamic pi-ask Choices Contract Testing Design

**Date:** 2026-04-26
**Status:** Validated -- ready for implementation
**Scope:** pi-wendao TypeScript CLI, qianji BPMN userTask interactions with dynamic `choicesRef` / `questionRef`

---

## 1  Problem Statement

pi-wendao compiles SKILL.md into qianji BPMN and executes workflows through the
qianji external host. A `userTask` can declare **static** choices as a JSON
literal on `dataInput name="choices"` or **dynamic** choices through a
`dataInputAssociation/sourceRef` such as `currentChoices`. A dynamic question
uses the same native sourceRef pattern for `dataInput name="question"`.

The current test suite (`test/executor/interaction-contract.test.ts`) covers:

- Parsing every interaction shape from a BPMN fixture.
- Resolving `choicesRef` / `questionRef` when given valid variables.
- Rejecting malformed `questionRef` (non-string) and `choicesRef` (items without `value`).
- Rejecting malformed dynamic choices before pi-ask rendering.

What is **not yet covered**:

1. Broad producer contract validation -- verifying that a producer declaring
   `outputSchema kind="choice_array"` actually emits well-formed arrays when
   multiple edge-case shapes appear (empty arrays, mixed optional fields,
   numeric values).
2. End-to-end resolution through `start-at-node` -- proving that pre-seeded
   variables reach `resolveHumanTaskConfig` and produce the correct pi-ask
   payload when pi-wendao runs the host runner directly.

This design addresses both gaps using a hybrid approach.

---

## 2  Approach: Option C (Hybrid Contract + start-at-node)

### 2.1  Why Option C

| Approach | Confidence | Maintenance | Coverage |
|----------|-----------|-------------|----------|
| A -- Full E2E BPMN fixture | High | Brittle; breaks on host/pi-ask contract changes | Broad but opaque failures |
| B -- Targeted contract validation | Medium | Easy to debug | Misses variable-binding bugs |
| **C -- Hybrid** | **High** | **Moderate; extends existing patterns** | **Broad contract + targeted integration** |

Option C extends the existing `interaction-contract.test.ts` pattern, adding
broader producer schema tests and 2-3 `start-at-node` integration tests that
prove the host runner resolves dynamic choices end-to-end.

### 2.2  Implementation Boundary

All new tests live in a single file:

```
test/executor/dynamic-choices-contract.test.ts
```

This file imports from the same modules the existing tests use:
- `buildPiWendaoConfigMap` from `../../src/executor/bpmn-config.js`
- `resolveHumanTaskConfig`, `validateOutputSchemas` from `../../src/executor/human-task.js`
- `buildPiWendaoAgentPrompt` from `../../src/executor/agent-host.js`

No new production code is required; the test exercises existing contracts.

---

## 3  Contract Validation Tests (Unit Layer)

### 3.1  Producer dynamic choices -- array shapes

Test matrix for `validateOutputSchemas`:

| Input | Expected result |
|-------|----------------|
| `[{ value: "a", label: "A" }, { value: "b" }]` | Passes (optional fields absent) |
| `[]` | Passes -- empty array is structurally valid for the schema (the consumer side rejects empty via `resolveHumanTaskConfig`) |
| `[{ label: "No value" }]` | Throws `HumanTaskContractError` with `invalid_dynamic_choices` |
| `[{ value: 42 }]` | Passes -- `readChoiceString` coerces numbers to strings |
| `[{ value: "x", description: "" }]` | Passes -- empty description is valid |
| `[{ value: "x", extra: "ignored" }]` | Passes -- `additionalProperties` not enforced at runtime |
| `"not-an-array"` | Throws -- ref did not resolve to a JSON array |

Each test case follows the existing pattern:

```typescript
it("validates producer choice_array: <case description>", () => {
  const config = {
    prompt: "...",
    tools: [],
    inputs: [],
    outputs: ["currentChoices"],
    outputSchemas: {
      currentChoices: {
        kind: "choice_array",
        value: "required" as const,
        label: "optional" as const,
        description: "optional" as const,
      },
    },
  };
  // ... assertion on validateOutputSchemas or expected throw
});
```

### 3.2  Consumer resolveHumanTaskConfig -- dynamic ref edge cases

| Input variables | Expected result |
|-----------------|----------------|
| `currentQuestion: ""` | Throws -- empty string fails `value.trim()` check |
| `currentChoices: "serialized json array"` | Throws -- dynamic choices must be a native array, not a string |
| `currentChoices: "[not json"` | Throws -- dynamic choices must be a native array, not a string |
| `currentChoices: [{ value: "x" }, { value: "x" }]` | Passes -- duplicates are allowed |
| `currentQuestion: "  spaced  "` | Resolves to `"spaced"` (trimmed) |
| `currentChoices: [42, "hello"]` | Throws -- non-object items |
| `currentChoices: [{ value: 1 }]` | Throws -- `value` must be a string |

### 3.3  Prompt integration -- outputSchema in agent prompt

Verify that `buildPiWendaoAgentPrompt` describes `currentChoices` as a native
JSON array of objects with a string `value` field when the task documentation
asks for dynamic choices.

---

## 4  Integration Tests (start-at-node Layer)

### 4.1  Fixture: producer + consumer chain

Create a minimal BPMN fixture `test/fixtures/producer-consumer-choices.bpmn`
containing:

```
Start -> Task_ProduceChoices (serviceTask) -> Task_AskChoice (userTask) -> End
```

- `Task_ProduceChoices` declares native data outputs `currentQuestion` and
  `currentChoices`.
- `Task_AskChoice` maps `dataInput name="choices"` from `currentChoices` and
  `dataInput name="question"` from `currentQuestion`.

### 4.2  Test: start-at-node at producer, host fixture resolves choices

```typescript
it("resolves dynamic choices via start-at-node with host fixture", async () => {
  // 1. Parse config map from the fixture BPMN
  // 2. Build a HostCompletionFixture with service_tasks.Task_ProduceChoices.data
  //    containing valid currentQuestion + currentChoices
  // 3. Call resolveHumanTaskConfig on the userTask config with those variables
  // 4. Assert the resolved interaction has the correct question and choices
});
```

This proves the **producer-to-consumer handoff**: the host fixture simulates a
producer completing, and `resolveHumanTaskConfig` correctly resolves the refs.

### 4.3  Test: start-at-node at consumer with pre-seeded variables

```typescript
it("renders user prompt from pre-seeded dynamic variables", () => {
  // 1. Parse config map from fixture BPMN
  // 2. Call resolveHumanTaskConfig directly with pre-seeded variables
  // 3. Build the agent prompt from the resolved config
  // 4. Assert the prompt contains the resolved question text
  // 5. Assert the prompt contains the resolved choices (not the ref)
});
```

This proves **direct variable injection**: a `--start-at-node Task_AskChoice`
call with `--context-json` works.

### 4.4  Test: producer emits bad choices, error surfaces before user prompt

```typescript
it("rejects producer output before rendering user prompt", () => {
  // 1. Parse config map from fixture BPMN
  // 2. Call validateOutputSchemas with bad currentChoices (strings instead of objects)
  // 3. Assert HumanTaskContractError is thrown with producer role
  // 4. Verify resolveHumanTaskConfig is never called (the error stops the flow)
});
```

This proves the **fail-fast contract**: bad producer output is caught by
`validateOutputSchemas` before `resolveHumanTaskConfig` attempts to render a
user prompt.

---

## 5  File Layout

```
test/
  executor/
    interaction-contract.test.ts          # existing -- unchanged
    dynamic-choices-contract.test.ts      # NEW -- all tests above
  fixtures/
    pi-ask-interactions.bpmn              # existing -- unchanged
    producer-consumer-choices.bpmn        # NEW -- minimal producer+consumer chain
```

No production code changes are required.

---

## 6  Acceptance Criteria

1. All existing tests continue to pass (`npm test` green).
2. New file `test/executor/dynamic-choices-contract.test.ts` has 10+ test cases
   covering producer schema validation, consumer ref resolution edge cases,
   prompt integration, and start-at-node integration.
3. New fixture `test/fixtures/producer-consumer-choices.bpmn` is valid BPMN
   with `Process_ProducerConsumerChoices`.
4. Each test name clearly states the contract boundary it validates.
5. Snapshot tests are used for error message formatting, matching the existing
   convention in `interaction-contract.test.ts`.

---

## 7  Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Snapshot churn from error message wording changes | Use `toContain` for key substrings (error code, variable name) alongside snapshots |
| Fixture drift if BPMN schema evolves | Fixture is minimal (2 tasks, 6 elements); update is mechanical |
| Tests pass but integration fails in real qianji run | start-at-node tests exercise the actual `resolveHumanTaskConfig` + `buildPiWendaoAgentPrompt` pipeline, not just isolated validators |

---

## 8  References

- `src/executor/human-task.ts` -- `resolveHumanTaskConfig`, `validateOutputSchemas`, `HumanTaskContractError`
- `src/executor/agent-host.ts` -- `buildPiWendaoAgentPrompt`, `PiWendaoConfig`, `QianjiInteraction`
- `src/executor/bpmn-config.ts` -- `buildPiWendaoConfigMap`
- `test/executor/interaction-contract.test.ts` -- existing contract tests
- `test/fixtures/pi-ask-interactions.bpmn` -- existing BPMN fixture with all interaction shapes
- `docs/start-at-node.md` -- start-at-node feature documentation
