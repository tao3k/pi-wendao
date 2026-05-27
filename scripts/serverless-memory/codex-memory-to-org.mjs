#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output) {
  console.error(
    [
      "Usage: node scripts/serverless-memory/codex-memory-to-org.mjs --input <MEMORY.md> --output <corpus.org> [--query <text>] [--max-groups <n>]",
      "",
      "This script imports Codex Markdown memory into an Org-native memory corpus.",
      "The generated Org file is the benchmark input; runtime recall still uses wendao-client orgize packets.",
    ].join("\n"),
  );
  process.exit(2);
}

const inputPath = resolve(args.input);
const outputPath = resolve(args.output);
const markdown = readFileSync(inputPath, "utf-8");
const groups = parseCodexMemoryGroups(markdown, inputPath)
  .filter((group) => groupMatchesQuery(group, args.query))
  .slice(0, args.maxGroups ?? 8);
const org = renderCodexMemoryOrg(groups, inputPath);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, org);
console.error(
  JSON.stringify(
    {
      schema: "xiuxian_wendao.codex_memory_org_import_report.v1",
      input: inputPath,
      output: outputPath,
      groups: groups.length,
      query: args.query ?? null,
    },
    null,
    2,
  ),
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") parsed.input = argv[++index];
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg === "--query") parsed.query = argv[++index];
    else if (arg === "--max-groups") parsed.maxGroups = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function parseCodexMemoryGroups(markdown, sourcePath) {
  const lines = markdown.split(/\r?\n/);
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("# Task Group: "));
  const groups = [];
  for (let groupIndex = 0; groupIndex < starts.length; groupIndex += 1) {
    const start = starts[groupIndex]?.index ?? 0;
    const endExclusive = starts[groupIndex + 1]?.index ?? lines.length;
    const groupLines = lines.slice(start, endExclusive);
    const title = groupLines[0]?.replace(/^# Task Group:\s*/, "").trim() ?? "Codex memory";
    groups.push(
      parseCodexMemoryGroup({
        title,
        lines: groupLines,
        sourcePath,
        sourceStartLine: start + 1,
        sourceEndLine: endExclusive,
        groupIndex: groupIndex + 1,
      }),
    );
  }
  return groups;
}

function parseCodexMemoryGroup(input) {
  const scope = lineValue(input.lines, "scope:");
  const appliesTo = lineValue(input.lines, "applies_to:");
  const tasks = collectTaskHeadings(input.lines);
  const keywords = collectListItemsAfterHeadings(input.lines, ["### keywords"]);
  const preferences = collectListItemsAfterHeadings(input.lines, ["## User preferences"]);
  const reusableKnowledge = collectListItemsAfterHeadings(input.lines, ["## Reusable knowledge"]);
  const failures = collectListItemsAfterHeadings(input.lines, [
    "## Failures and how to do differently",
  ]);
  return {
    title: input.title,
    orgid: `codex-memory-${String(input.groupIndex).padStart(4, "0")}-${slugify(input.title)}`,
    sourceStartLine: input.sourceStartLine,
    sourceEndLine: input.sourceEndLine,
    scope,
    appliesTo,
    tasks,
    keywords,
    preferences,
    reusableKnowledge,
    failures,
  };
}

function renderCodexMemoryOrg(groups, sourcePath) {
  const lines = [
    "#+TITLE: Imported Codex Memory Corpus",
    "#+AUTHOR: CyberXiuXian Artisan workshop",
    "#+FILETAGS: :agent:memory:codex_import:",
    "#+DATE: 2026-05-25 Mon 11:55:00",
    "",
  ];
  for (const group of groups) {
    lines.push(...renderCodexMemoryGroup(group, sourcePath), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderCodexMemoryGroup(group, sourcePath) {
  const claim = firstNonEmpty(group.reusableKnowledge, group.scope, group.title);
  const preference = firstNonEmpty(group.preferences);
  const failure = firstNonEmpty(group.failures);
  const evidence = `${sourcePath}:${group.sourceStartLine}:${group.sourceEndLine}`;
  return [
    `* DONE ${escapeOrgInline(group.title)} :agent:memory:codex_import:`,
    "CLOSED: [2026-05-25 Mon]",
    ":PROPERTIES:",
    `:ID: ${group.orgid}`,
    ":MEMORY_SOURCE: codex-memory",
    `:SOURCE_PATH: ${escapePropertyValue(sourcePath)}`,
    `:SOURCE_LINES: ${group.sourceStartLine}:${group.sourceEndLine}`,
    ":TASK_OUTCOME: success",
    `:CLAIM: ${escapePropertyValue(claim)}`,
    `:REUSABLE_KNOWLEDGE: ${escapePropertyValue(claim)}`,
    ...(preference ? [`:PREFERENCE: ${escapePropertyValue(preference)}`] : []),
    ...(failure ? [`:FAILURE_NOTE: ${escapePropertyValue(failure)}`] : []),
    `:EVIDENCE: ${escapePropertyValue(evidence)}`,
    ":END:",
    "",
    group.scope ? `Source scope: ${group.scope}` : "Source scope: not recorded.",
    group.appliesTo ? `Applies to: ${group.appliesTo}` : "Applies to: not recorded.",
    "",
    groupSectionHeading(group, "Imported Tasks"),
    ...renderList(group.tasks),
    "",
    groupSectionHeading(group, "Keywords"),
    ...renderList(group.keywords),
    "",
    groupSectionHeading(group, "Reusable Knowledge"),
    ...renderList(group.reusableKnowledge),
    "",
    groupSectionHeading(group, "User Preferences"),
    ...renderList(group.preferences),
    "",
    groupSectionHeading(group, "Failures And Fixes"),
    ...renderList(group.failures),
    "",
    groupSectionHeading(group, "Reflection Questions"),
    "| Question | Value |",
    "|---+---|",
    `| What finality signal should future agents recall from this imported memory? | Imported from Codex memory group lines ${group.sourceStartLine}-${group.sourceEndLine}. |`,
    `| Which claim became stronger, weaker, or superseded? | ${escapeTableCell(claim)} |`,
    `| Which evidence should be cited for this memory? | ${escapeTableCell(evidence)} |`,
    `| Which failure mode should future agents avoid? | ${escapeTableCell(failure || "No failure note was recorded in the source group.")} |`,
    `| Which preference or naming correction should future generated plans preserve? | ${escapeTableCell(preference || "No explicit preference was recorded in the source group.")} |`,
  ];
}

function groupSectionHeading(group, label) {
  return `** ${label} (${group.orgid})`;
}

function groupMatchesQuery(group, query) {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return [
    group.title,
    group.scope,
    group.appliesTo,
    ...group.tasks,
    ...group.keywords,
    ...group.preferences,
    ...group.reusableKnowledge,
    ...group.failures,
  ]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

function lineValue(lines, prefix) {
  return (
    lines
      .find((line) => line.toLowerCase().startsWith(prefix.toLowerCase()))
      ?.slice(prefix.length)
      .trim() ?? ""
  );
}

function collectTaskHeadings(lines) {
  return lines
    .filter((line) => line.startsWith("## Task "))
    .map((line) => line.replace(/^##\s*/, "").trim());
}

function collectListItemsAfterHeadings(lines, headings) {
  const normalizedHeadings = new Set(headings.map((heading) => heading.toLowerCase()));
  const items = [];
  let active = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      active = normalizedHeadings.has(trimmed.toLowerCase());
      continue;
    }
    if (!active || !trimmed.startsWith("- ")) continue;
    items.push(trimmed.slice(2).trim());
  }
  return items;
}

function renderList(items) {
  if (items.length === 0) return ["- not recorded"];
  return items.map((item) => `- ${escapeOrgInline(item)}`);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = value.find((item) => item.trim().length > 0);
      if (first) return first;
      continue;
    }
    if (value.trim().length > 0) return value;
  }
  return "Imported Codex memory group.";
}

function escapePropertyValue(value) {
  return escapeOrgInline(value).replace(/\s+/g, " ").trim();
}

function escapeTableCell(value) {
  return escapeOrgInline(value).replaceAll("|", "\\vert{}");
}

function escapeOrgInline(value) {
  return value.replace(/\r?\n/g, " ").trim();
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "memory";
}
