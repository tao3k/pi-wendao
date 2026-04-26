# Justfile for pi-wendao/qianji BPMN integration tests.
# Run from the pi-wendao package root.

set dotenv-load := false
set shell := ["bash", "-uc"]
set positional-arguments := true

qianji := "qianji"
pi_wendao := "npx --no-install pi-wendao"

default:
    @just --list

# Typecheck pi-wendao.
check:
    npm run check

# Build pi-wendao.
build:
    npm run build

# Run the Vitest suite.
test:
    npm test

# Check whitespace in the pi-wendao nested repo.
diff-check:
    git diff --check

# Run local verification without real LLM calls.
verify-local: check build test diff-check lint-fixtures run-simple-fixture run-complex-fixture parallel-boundary

# Show the qianji binary resolved through PATH.
qianji-path:
    command -v qianji

# Show qianji BPMN checkpoint instances through pi-wendao.
show-instances workflow="/tmp/pi-wendao-real-llm-complex.bpmn":
    {{pi_wendao}} "{{workflow}}" --show

# Show one qianji BPMN checkpoint instance through pi-wendao.
show-instance instance workflow="/tmp/pi-wendao-real-llm-complex.bpmn":
    {{pi_wendao}} "{{workflow}}" --show --instance-id "{{instance}}"

# Lint one BPMN file with qianji.
lint-bpmn bpmn:
    #!/usr/bin/env bash
    set -euo pipefail

    bpmn="{{bpmn}}"
    if [[ "$bpmn" != /* ]]; then
      bpmn="$PWD/$bpmn"
    fi

    {{qianji}} lint --bpmn "$bpmn"

# Lint the BPMN fixtures that cover the supported pi-wendao subset.
lint-fixtures:
    #!/usr/bin/env bash
    set -euo pipefail

    for bpmn in \
      "$PWD/test/fixtures/simple-workflow.bpmn" \
      "$PWD/test/fixtures/simple-skill.bpmn" \
      "$PWD/test/fixtures/error-workflow.bpmn" \
      "$PWD/test/fixtures/complex-workflow.bpmn" \
      "$PWD/test/fixtures/complex-skill.bpmn" \
      "$PWD/test/fixtures/human-approval.bpmn" \
      "$PWD/.pi/named-workflows/brainstorm.bpmn"
    do
      {{qianji}} lint --bpmn "$bpmn"
    done

# Execute a simple workflow through pi-wendao with deterministic host data.
run-simple-fixture:
    #!/usr/bin/env bash
    set -euo pipefail

    fixture="/tmp/pi-wendao-simple-host-fixture.json"
    instance="pi-wendao-simple-fixture-$(date +%Y%m%d%H%M%S)"
    cat > "$fixture" <<'JSON'
    {
      "service_tasks": {
        "Task_1": {
          "data": {
            "fileList": ["package.json", "src"]
          }
        }
      }
    }
    JSON

    {{pi_wendao}} test/fixtures/simple-workflow.bpmn \
      --no-graph \
      --host-fixture "$fixture" \
      --instance-id "$instance"

# Execute the complex fixture end-to-end through qianji with deterministic host data.
run-complex-fixture:
    #!/usr/bin/env bash
    set -euo pipefail

    fixture="/tmp/pi-wendao-complex-host-fixture.json"
    instance="pi-wendao-complex-fixture-$(date +%Y%m%d%H%M%S)"
    bpmn="$PWD/test/fixtures/complex-workflow.bpmn"
    cat > "$fixture" <<'JSON'
    {
      "service_tasks": {
        "Task_Init": { "data": { "status": "ready", "isReady": true } },
        "Task_Retry": { "data": { "status": "ready", "isReady": true } },
        "Task_FetchA": { "data": { "resultA": "alpha" } },
        "Task_FetchB": { "data": { "resultB": "beta" } },
        "Task_Merge": { "data": { "merged": "alpha,beta" } },
        "Task_Validate": { "data": { "valid": true } },
        "Task_Fallback": { "data": { "valid": false, "reason": "validation failed" } },
        "Task_Publish": { "data": { "published": true } },
        "Task_Reject": { "data": { "rejected": true } }
      }
    }
    JSON

    {{qianji}} bpmn run \
      --bpmn "$bpmn" \
      --process Process_1 \
      --instance-id "$instance" \
      --context-json '{}' \
      --host-fixture "$fixture" \
      --trace-stream

# Stop at the complex workflow's qianji parallel boundary and show two pending host tasks.
parallel-boundary:
    #!/usr/bin/env bash
    set -euo pipefail

    fixture="/tmp/pi-wendao-complex-init-fixture.json"
    instance="pi-wendao-parallel-boundary-$(date +%Y%m%d%H%M%S)"
    bpmn="$PWD/test/fixtures/complex-workflow.bpmn"
    cat > "$fixture" <<'JSON'
    {
      "service_tasks": {
        "Task_Init": {
          "data": {
            "status": "ready",
            "isReady": true
          }
        }
      }
    }
    JSON

    {{qianji}} bpmn run \
      --bpmn "$bpmn" \
      --process Process_1 \
      --instance-id "$instance" \
      --context-json '{}' \
      --external-host

    {{qianji}} bpmn tasks complete \
      --bpmn "$bpmn" \
      --instance-id "$instance" \
      --host-fixture "$fixture" \
      --external-host

# Run the real LLM simple workflow generated during integration testing.
real-llm-simple workflow="/tmp/pi-wendao-real-llm-simple.bpmn" thinking="low":
    #!/usr/bin/env bash
    set -euo pipefail

    if [ ! -f "{{workflow}}" ]; then
      echo "Missing workflow: {{workflow}}" >&2
      echo "Generate or pass one explicitly: just real-llm-simple /tmp/your.bpmn low" >&2
      exit 1
    fi

    {{pi_wendao}} "{{workflow}}" \
      --no-graph \
      --thinking "{{thinking}}" \
      --instance-id "pi-wendao-real-llm-$(date +%Y%m%d%H%M%S)"

# Run the checked complex workflow through pi-wendao with deterministic host data.
pi-wendao-complex-fixture:
    #!/usr/bin/env bash
    set -euo pipefail

    fixture="/tmp/pi-wendao-complex-host-fixture.json"
    instance="pi-wendao-complex-$(date +%Y%m%d%H%M%S)"
    cat > "$fixture" <<'JSON'
    {
      "service_tasks": {
        "Task_Init": { "data": { "status": "ready", "isReady": true } },
        "Task_Retry": { "data": { "status": "ready", "isReady": true } },
        "Task_FetchA": { "data": { "resultA": "alpha" } },
        "Task_FetchB": { "data": { "resultB": "beta" } },
        "Task_Merge": { "data": { "merged": "alpha,beta" } },
        "Task_Validate": { "data": { "valid": true } },
        "Task_Fallback": { "data": { "valid": false, "reason": "validation failed" } },
        "Task_Publish": { "data": { "published": true } },
        "Task_Reject": { "data": { "rejected": true } }
      }
    }
    JSON

    {{pi_wendao}} test/fixtures/complex-workflow.bpmn \
      --no-graph \
      --host-fixture "$fixture" \
      --instance-id "$instance"

# Run the graph-local human approval demo. Type a response at the user> prompt.
human-approval-demo idea="Ship graph-local approval":
    {{pi_wendao}} test/fixtures/human-approval.bpmn \
      --var "idea={{idea}}" \
      --instance-id "pi-wendao-human-approval-$(date +%Y%m%d%H%M%S)"

# Print representative commands for pi-subagents/manual extension checks.
pi-subagents-notes:
    @echo "pi-subagents is built into pi-wendao from package dependencies."
    @echo "-e is only for extra development extensions or local overrides."
    @echo "Expected tools when extension is active: Agent, get_subagent_result, steer_subagent"
    @echo "Use only when a skill declares those tools or the pi runtime exposes them."
