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

Consumer-side start-at probes do not validate producer behavior. For dynamic
interaction variables such as a `choices` data input mapped from
`currentChoices`, a probe that starts directly at the `userTask` only validates
the supplied `--context-json` value. To test the producer shape that a workflow
will create in a real run, start before the service task that emits the
variable and pass a `--host-fixture` entry for that producer.

## User Prompt Stall Guard

During native host handling, pi-wendao records the resolved user-facing
`userTask` prompt for the current run. If qianji returns the same user task with
the same question, choices, and declared native input values again before
those inputs change, pi-wendao stops the run with `Workflow user input stall
detected` and the diagnostic code `pi-wendao.runtime.user_prompt_stall`.

This guard does not replace `qianji lint`. It catches runtime-only loops where
the BPMN is structurally valid but the next question service did not consume
the previous user answer or update a route/progress variable. The checkpoint is
left in qianji so the workflow can be repaired or cancelled explicitly.
The diagnostic lists the unchanged inputs and userTask outputs so the same text
can be fed back into the compiler repair loop.

The same `userTask` can still be revisited when the resolved question, choices,
or declared native input values change. Iterative workflows should expose their
loop progress through those declared inputs.
