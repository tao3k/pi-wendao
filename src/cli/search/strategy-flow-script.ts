export const JULIA_STRATEGY_FLOW_SCRIPT = String.raw`
using WendaoGraph

intent = ARGS[1]
search_root = ARGS[2]

function json_escape(value)
    text = string(value)
    text = replace(text, "\\" => "\\\\")
    text = replace(text, "\"" => "\\\"")
    text = replace(text, "\n" => "\\n")
    text = replace(text, "\r" => "\\r")
    text = replace(text, "\t" => "\\t")
    "\"$text\""
end

function json_value(value)
    if value isa AbstractString
        return json_escape(value)
    elseif value isa Bool
        return value ? "true" : "false"
    elseif value isa Integer || value isa AbstractFloat
        return string(value)
    elseif value isa AbstractVector
        return "[" * join(json_value.(value), ",") * "]"
    end
    json_escape(value)
end

function json_object(pairs)
    "{" * join(["$(json_escape(first(pair))):$(json_value(last(pair)))" for pair in pairs], ",") * "}"
end

function json_pair(name, raw_value)
    "$(json_escape(name)):$(raw_value)"
end

function split_candidate_id(candidate_id)
    parts = split(candidate_id, Char(0x23); limit=2)
    relative_path = String(parts[1])
    heading_anchor = length(parts) == 2 ? String(parts[2]) : ""
    relative_path, heading_anchor
end

function real_doc_path(relative_path)
    joinpath(search_root, split(relative_path, '/')...)
end

function markdown_anchor(title)
    text = lowercase(strip(replace(title, Char(0x60) => "")))
    text = replace(text, r"[^a-z0-9]+" => "-")
    text = replace(text, r"^-+" => "")
    text = replace(text, r"-+$" => "")
    isempty(text) ? "section" : text
end

function markdown_section_text(candidate_id)
    relative_path, heading_anchor = split_candidate_id(candidate_id)
    path = real_doc_path(relative_path)
    isfile(path) || return ""
    text = read(path, String)
    isempty(heading_anchor) && return text

    lines = split(text, '\n'; keepempty=true)
    heading_pattern = r"^(#{1,6})\s+(.+?)\s*$"
    selected = String[]
    in_section = false
    section_level = 0

    for line in lines
        matched = match(heading_pattern, line)
        if matched !== nothing
            level = length(matched.captures[1])
            title = strip(matched.captures[2])
            if in_section && level <= section_level
                break
            end
            if !in_section && markdown_anchor(title) == heading_anchor
                in_section = true
                section_level = level
                push!(selected, line)
                continue
            end
        end
        in_section && push!(selected, line)
    end

    join(selected, "\n")
end

function doc_context_cost(candidate_id)
    text = markdown_section_text(candidate_id)
    isempty(text) && return 512
    max(1, ceil(Int, sizeof(text) / 20))
end

function doc_candidate(relative_path, heading_anchor; evidence_coverage, graph_score, authority_score, structural_score, uncertainty, blocked=false, edge_kinds=("anchor", "linkography", "authority"))
    candidate_id = "$(relative_path)#$(heading_anchor)"
    (
        candidate_id = candidate_id,
        candidate_kind = "markdown_heading_section",
        node_ids = ["intent", relative_path, candidate_id, "markdown-section", "package-docs"],
        edge_kinds = collect(edge_kinds),
        evidence_coverage = evidence_coverage,
        graph_score = graph_score,
        authority_score = authority_score,
        semantic_score = 0.0,
        structural_score = structural_score,
        context_cost = doc_context_cost(candidate_id),
        uncertainty = uncertainty,
        blocked = blocked,
    )
end

flow_id = "pi-wendao-search-strategy-flow"
query_understanding = query_understanding_evidence_rows(intent; flow_id = flow_id, intent_id = "cli-intent-1")
strategy_budget = (
    source = isempty(query_understanding) ? "default" : "query_understanding",
    loop_budget = isempty(query_understanding) ? 1 : maximum(row.recommended_loop_budget for row in query_understanding),
    judgement_budget = isempty(query_understanding) ? 1 : maximum(row.recommended_judgement_budget for row in query_understanding),
    beam_width = isempty(query_understanding) ? 3 : maximum(row.recommended_beam_width for row in query_understanding),
)

normalized_intent = lowercase(intent)
strategy_weight = occursin("strategy", normalized_intent) || occursin("search", normalized_intent) || occursin("flow", normalized_intent) ? 0.04 : 0.0
page_index_weight = occursin("page", normalized_intent) || occursin("index", normalized_intent) ? 0.03 : 0.0

candidates = [
    doc_candidate(
        "docs/30_search_strategy/30.01_search_strategy_flow.md",
        "stage-1-query-understanding";
        evidence_coverage = min(1.0, 0.94 + strategy_weight),
        graph_score = min(1.0, 0.91 + strategy_weight),
        authority_score = 0.93,
        structural_score = 0.90,
        uncertainty = 0.09,
        edge_kinds = ("anchor", "search-strategy", "authority", "page-index"),
    ),
    doc_candidate(
        "docs/30_search_strategy/30.01_search_strategy_flow.md",
        "ownership-boundary";
        evidence_coverage = min(1.0, 0.88 + strategy_weight),
        graph_score = min(1.0, 0.84 + strategy_weight),
        authority_score = 0.96,
        structural_score = 0.84,
        uncertainty = 0.12,
        edge_kinds = ("anchor", "authority", "ownership", "ssot"),
    ),
    doc_candidate(
        "docs/20_page_index/20.01_reasoning_tree_contracts.md",
        "relationship-to-search-strategy";
        evidence_coverage = min(1.0, 0.76 + page_index_weight),
        graph_score = min(1.0, 0.80 + page_index_weight),
        authority_score = 0.84,
        structural_score = 0.88,
        uncertainty = 0.22,
        edge_kinds = ("anchor", "page-index", "evidence-plane"),
    ),
    doc_candidate(
        "docs/10_graph_compute/10.01_link_graph_compute.md",
        "how-this-helps-linkgraph-search";
        evidence_coverage = 0.63,
        graph_score = 0.79,
        authority_score = 0.70,
        structural_score = 0.66,
        uncertainty = 0.34,
        edge_kinds = ("linkography", "graph-compute", "supporting-evidence"),
    ),
    doc_candidate(
        "docs/90_validation/90.01_validation.md",
        "package-test";
        evidence_coverage = 0.80,
        graph_score = 0.72,
        authority_score = 0.82,
        structural_score = 0.76,
        uncertainty = 0.16,
        edge_kinds = ("validation", "package-test", "proof"),
    ),
    doc_candidate(
        "docs/90_validation/90.01_validation.md",
        "promotion-boundary";
        evidence_coverage = 0.74,
        graph_score = 0.65,
        authority_score = 0.82,
        structural_score = 0.72,
        uncertainty = 0.18,
        blocked = true,
        edge_kinds = ("validation", "negative-guard"),
    ),
]

rows = strategy_flow_candidate_rows(
    candidates;
    flow_id = flow_id,
    revision_id = "query-graph-cli-1",
    keep_threshold = 0.70,
    expand_threshold = 0.45,
    context_budget = 4096,
    query_understanding = query_understanding,
)
transitions = strategy_flow_transition_rows(rows; flow_id = flow_id)
frontier = strategy_flow_frontier_rows(
    rows;
    flow_id = flow_id,
    beam_width = strategy_budget.beam_width,
    context_budget = 1900,
    query_understanding = query_understanding,
)
required_evidence_coverage = strategy_flow_required_evidence_coverage(frontier, query_understanding)
actions = strategy_flow_planner_action_rows(
    rows,
    transitions,
    frontier;
    flow_id = flow_id,
    loop_budget = strategy_budget.loop_budget,
    judgement_budget = strategy_budget.judgement_budget,
    compare_count = 1,
)

function query_understanding_json(row)
    json_object((
        "flowId" => row.flow_id,
        "intentId" => row.intent_id,
        "signalId" => row.signal_id,
        "signalKind" => row.signal_kind,
        "signalValue" => row.signal_value,
        "confidence" => row.confidence,
        "routeHint" => row.route_hint,
        "requiredEvidence" => row.required_evidence,
        "ambiguity" => row.ambiguity,
        "weight" => row.weight,
        "recommendedLoopBudget" => row.recommended_loop_budget,
        "recommendedJudgementBudget" => row.recommended_judgement_budget,
        "recommendedBeamWidth" => row.recommended_beam_width,
        "reason" => row.reason,
    ))
end

function strategy_budget_json(row)
    json_object((
        "source" => row.source,
        "loopBudget" => row.loop_budget,
        "judgementBudget" => row.judgement_budget,
        "beamWidth" => row.beam_width,
    ))
end

function candidate_json(row)
    json_object((
        "candidateId" => row.candidate_id,
        "action" => row.action,
        "reason" => row.reason,
        "finalScore" => row.final_score,
        "evidenceCoverage" => row.evidence_coverage,
        "graphScore" => row.graph_score,
        "authorityScore" => row.authority_score,
        "semanticScore" => row.semantic_score,
        "structuralScore" => row.structural_score,
        "contextCost" => row.context_cost,
        "blocked" => row.blocked,
    ))
end

function frontier_json(row)
    json_object((
        "candidateId" => row.candidate_id,
        "rank" => row.rank,
        "selected" => row.selected,
        "finalScore" => row.final_score,
        "action" => row.action,
        "contextBudget" => row.context_budget,
        "judgementKind" => row.judgement_kind,
    ))
end

function action_json(row)
    json_object((
        "actionKind" => row.action_kind,
        "candidateId" => row.candidate_id,
        "targetCandidateId" => row.target_candidate_id,
        "cycleAllowed" => row.cycle_allowed,
        "requiresLlmJudgement" => row.requires_llm_judgement,
        "score" => row.score,
        "contextBudget" => row.context_budget,
        "reason" => row.reason,
    ))
end

function stage_receipt_json(row)
    json_object((
        "stage" => row.stage,
        "notebook" => row.notebook,
        "inputCount" => row.input_count,
        "outputCount" => row.output_count,
        "selectedCount" => row.selected_count,
        "llmJudgementCount" => row.llm_judgement_count,
        "cycleAllowedCount" => row.cycle_allowed_count,
        "contextBudget" => row.context_budget,
        "summary" => row.summary,
    ))
end

total_context = sum(row.context_cost for row in rows)
selected_context = sum(row.context_budget for row in frontier)
selected_ids = [row.candidate_id for row in frontier if row.selected]
llm_action_count = count(row -> row.requires_llm_judgement, actions)
cycle_action_count = count(row -> row.cycle_allowed, actions)
stage_receipts = [
    (
        stage = "query_understanding",
        notebook = "notebooks/search_strategy_flow_query_understanding.jl",
        input_count = 1,
        output_count = length(query_understanding),
        selected_count = 0,
        llm_judgement_count = 0,
        cycle_allowed_count = 0,
        context_budget = 0,
        summary = "intent to graph route hints, required evidence, ambiguity, and strategy budget",
    ),
    (
        stage = "candidate_scoring",
        notebook = "notebooks/search_strategy_flow_candidate_scoring.jl",
        input_count = length(candidates),
        output_count = length(rows),
        selected_count = count(row -> row.action != "prune", rows),
        llm_judgement_count = 0,
        cycle_allowed_count = 0,
        context_budget = total_context,
        summary = "graph evidence rows to deterministic score rows and branch actions",
    ),
    (
        stage = "transition_inference",
        notebook = "notebooks/search_strategy_flow_transition_inference.jl",
        input_count = length(rows),
        output_count = length(transitions),
        selected_count = count(row -> row.transition_kind != "stop_branch", transitions),
        llm_judgement_count = 0,
        cycle_allowed_count = 0,
        context_budget = 0,
        summary = "score rows to revision transition kinds and missing-signal diagnostics",
    ),
    (
        stage = "frontier_selection",
        notebook = "notebooks/search_strategy_flow_frontier_selection.jl",
        input_count = length(rows),
        output_count = length(frontier),
        selected_count = length(selected_ids),
        llm_judgement_count = count(row -> row.selected && row.judgement_kind == "subagent_branch_judgement", frontier),
        cycle_allowed_count = 0,
        context_budget = selected_context,
        summary = "beam and context-budget bounded Agent-visible frontier",
    ),
    (
        stage = "planner_actions",
        notebook = "notebooks/search_strategy_flow_planner_actions.jl",
        input_count = length(frontier),
        output_count = length(actions),
        selected_count = count(row -> row.action_kind != "stop", actions),
        llm_judgement_count = llm_action_count,
        cycle_allowed_count = cycle_action_count,
        context_budget = sum(row.context_budget for row in actions),
        summary = "frontier and transition facts to materialize, refine, judge, compare, and stop actions",
    ),
]
summary = json_object((
    "candidateCount" => length(rows),
    "selectedCount" => length(selected_ids),
    "plannerActionCount" => length(actions),
    "totalContextCost" => total_context,
    "selectedContextCost" => selected_context,
    "contextReductionRatio" => 1.0 - selected_context / total_context,
))
validation = json_object((
    "noVectorMode" => all(row.semantic_score == 0.0 for row in rows),
    "materializedTopCandidate" => any(row.action_kind == "materialize" && row.candidate_id == "docs/30_search_strategy/30.01_search_strategy_flow.md#stage-1-query-understanding" for row in actions),
    "blockedEvidencePruned" => any(row.candidate_id == "docs/90_validation/90.01_validation.md#promotion-boundary" && !row.selected for row in frontier),
    "selectedContextReduced" => selected_context < total_context,
    "requiredEvidenceCovered" => required_evidence_coverage.required_evidence_covered,
    "selectedRequiredEvidence" => required_evidence_coverage.selected_required_evidence,
    "missingRequiredEvidence" => required_evidence_coverage.missing_required_evidence,
))

println("{" * join((
    json_pair("intent", json_value(intent)),
    json_pair("backend", json_value("wendao-graph-julia")),
    json_pair("graphProject", json_value(Base.active_project() === nothing ? "" : dirname(Base.active_project()))),
    json_pair("searchRoot", json_value(search_root)),
    json_pair("queryUnderstanding", "[" * join(query_understanding_json.(query_understanding), ",") * "]"),
    json_pair("strategyBudget", strategy_budget_json(strategy_budget)),
    json_pair("stageReceipts", "[" * join(stage_receipt_json.(stage_receipts), ",") * "]"),
    json_pair("candidates", "[" * join(candidate_json.(rows), ",") * "]"),
    json_pair("frontier", "[" * join(frontier_json.(frontier), ",") * "]"),
    json_pair("plannerActions", "[" * join(action_json.(actions), ",") * "]"),
    json_pair("summary", summary),
    json_pair("validation", validation),
), ",") * "}")
`;
