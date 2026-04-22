---
name: complex-pipeline
description: A multi-stage pipeline with branching, parallelism, error handling, and retry
---

# Complex Pipeline

A dummy pipeline that exercises complex BPMN control flow. Every task just sleeps for 2 seconds.

## Steps

1. Initialize the system. Sleep 2 seconds. Set status to "ready".
2. Check if status is "ready". If not, retry initialization (go back to step 1).
3. Once ready, fork into two parallel branches:
   - Branch A: fetch data A. Sleep 2 seconds. Set resultA to "alpha".
   - Branch B: fetch data B. Sleep 2 seconds. Set resultB to "beta".
4. Wait for both branches to complete, then merge: sleep 2 seconds, concatenate resultA and resultB into merged.
5. Validate the merged result. Sleep 2 seconds. Set valid to true.
   - If validation fails (error), run a fallback: sleep 2 seconds, set valid to false and reason to "validation failed".
6. If valid, publish: sleep 2 seconds, set published to true, done.
7. If not valid, reject: sleep 2 seconds, set rejected to true, done.
