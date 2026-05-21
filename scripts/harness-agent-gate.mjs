#!/usr/bin/env node

import {
  assertTypeScriptProjectHarnessAgentClean,
  renderTypeScriptProjectHarnessAgentSnapshot,
  runTypeScriptProjectHarnessAgentSnapshot,
} from "typescript-lang-project-harness";

try {
  assertTypeScriptProjectHarnessAgentClean(new URL("../", import.meta.url));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("\nAgent snapshot:");
  console.error(
    renderTypeScriptProjectHarnessAgentSnapshot(
      runTypeScriptProjectHarnessAgentSnapshot(new URL("../", import.meta.url)),
    ),
  );
  process.exitCode = 1;
}
