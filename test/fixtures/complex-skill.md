---
name: complex-pipeline
description: A multi-stage pipeline with retry loop, parallelism, error handling, and counters
---

# Complex Pipeline

A dummy pipeline that exercises complex BPMN control flow. Every task just sleeps for 2 seconds.

## Steps

1. Initialize the system. Sleep 2 seconds. Set retryCount to 1. Set status to "not ready".
2. Check if retryCount >= 3. If yes, set status to "ready". If no, increment retryCount by 1 and go back to step 1.
3. Once status is "ready", fork into two parallel branches:
   - Branch A: sleep 2 seconds. Set resultA to "alpha".
   - Branch B: sleep 2 seconds. Set resultB to "beta".
4. Wait for both branches to complete, then merge: sleep 2 seconds, concatenate resultA and resultB into merged.
5. Validate the merged result. Sleep 2 seconds. Set valid to true.
   - If validation fails (error), run a fallback: sleep 2 seconds, set valid to false and reason to "validation failed".
6. If valid, publish: sleep 2 seconds, set published to true. Done.
7. If not valid, reject: sleep 2 seconds, set rejected to true. Done.
