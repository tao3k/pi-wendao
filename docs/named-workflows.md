# Named Workflows

`pi-wendao` supports stable named workflows for native TUI entry points. A named
workflow resolves a public command name to a concrete BPMN artifact before qianji
execution starts.

## `/run brainstorm`

`/run brainstorm` maps to the local brainstorming skill source at
`~/.agents/skills/brainstorming/SKILL.md` and writes the runnable BPMN cache to
`$PRJ_CACHE_HOME/pi-wendao/named-workflows/brainstorm.bpmn`. When
`PRJ_CACHE_HOME` is not set, the fallback cache root is
`.cache/pi-wendao/named-workflows/` under the invocation directory.

The current implementation uses the maintained canonical seed at
`.pi/named-workflows/brainstorm.bpmn` instead of asking the model to regenerate
BPMN XML on every run. The cache refreshes when either the source skill or the
canonical seed is newer than the cached BPMN.

The source skill remains the semantic owner for the named workflow, and the
canonical seed is the stable executable artifact used while the general skill to
BPMN compiler is being hardened.

Qianji still owns BPMN scheduling, gateway routing, checkpoints, and resume
state. `pi-wendao` only resolves the named workflow, refreshes the cache, starts
qianji execution, and renders host-native user interaction declared through
standard BPMN IO metadata.
