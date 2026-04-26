# Start At a BPMN Node

`pi-wendao` can forward a fresh start-at request to qianji:

```bash
pi-wendao workflow.bpmn \
  --process Process_1 \
  --start-at-node Task_Question \
  --instance-id wf_start_at_question \
  --context-json '{"currentQuestion":"What should we explore?"}'
```

The native TUI accepts the same option through `/run`:

```text
/run workflow.bpmn --process Process_1 --start-at-node Task_Question --instance-id wf_start_at_question
```

This flag starts a new qianji instance at the selected node. It does not jump
inside an existing checkpoint. To continue an existing waiting workflow, use
the same instance id without `--start-at-node` so qianji resumes from its saved
checkpoint.

Qianji remains the scheduler and checkpoint owner. pi-wendao only resolves CLI
options, renders host/user interaction, and forwards the start-at request.

For focused interaction tests, pass `--host-fixture` with service completion
data while still rendering `userTask` prompts through pi-wendao:

```json
{
  "service_tasks": {
    "Task_Deploy": {
      "data": {
        "deploymentStatus": "fixture-deployed"
      }
    }
  }
}
```

```bash
printf '\n' | pi-wendao workflow.bpmn \
  --start-at-node User_DeployApproval \
  --instance-id wf_deploy_probe \
  --context-json '{"qualityReport":"ok","skillContent":"draft"}' \
  --host-fixture host-fixture.json \
  --no-tui
```

When pi-wendao owns host handling, `userTask` nodes ignore fixture `user_tasks`
entries and use native UI input. Non-user host work can complete from
`service_tasks`, `service_task_tokens`, `manual_tasks`, or `send_tasks`.
