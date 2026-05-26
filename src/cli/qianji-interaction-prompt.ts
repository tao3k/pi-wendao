import type { ExtensionCommandContext, Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  type Component,
  type EditorTheme,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { QianjiInteraction, QianjiInteractionChoice } from "../executor/agent-host.js";
import type { PlannerReplyRequest } from "../ui/renderer.js";

export function resolveQianjiInteractionReply(
  interaction: QianjiInteraction,
  choice?: QianjiInteractionChoice,
  freeText = "",
): string | undefined {
  const trimmed = freeText.trim();
  if (trimmed && (interaction.type === "input" || interaction.type === "choice_input")) {
    return trimmed;
  }
  if (choice) return choice.value;
  return undefined;
}

export async function requestQianjiInteractionReply(
  ctx: ExtensionCommandContext,
  request: PlannerReplyRequest,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!ctx.hasUI || !request.interaction) return undefined;
  return ctx.ui
    .custom<string | undefined>(
      (tui, theme, _keybindings, done) =>
        new QianjiInteractionPromptComponent(tui, theme, request, done),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "80%",
          minWidth: 52,
          maxHeight: "80%",
          margin: 2,
        },
      },
    )
    .then((value) => (signal?.aborted ? undefined : value));
}

class QianjiInteractionPromptComponent implements Component {
  private readonly editor: Editor;
  private cachedLines: string[] | undefined;
  private editing: boolean;
  private optionIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: PiTheme,
    private readonly request: PlannerReplyRequest,
    private readonly done: (result: string | undefined) => void,
  ) {
    this.editing = choicesForInteraction(this.interaction).length === 0;
    this.editor = new Editor(tui, createEditorTheme(theme));
    this.editor.onSubmit = (value) => {
      this.done(resolveQianjiInteractionReply(this.interaction, this.selectedChoice(), value));
    };
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.editing) {
      if (matchesKey(data, Key.escape)) {
        if (choicesForInteraction(this.interaction).length > 0) {
          this.editing = false;
          this.editor.setText("");
          this.refresh();
          return;
        }
        this.done(undefined);
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.optionIndex = Math.max(0, this.optionIndex - 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.optionIndex = Math.min(
        choicesForInteraction(this.interaction).length - 1,
        this.optionIndex + 1,
      );
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.done(resolveQianjiInteractionReply(this.interaction, this.selectedChoice()));
      return;
    }
    if (matchesKey(data, Key.tab) && allowsFreeText(this.interaction)) {
      this.editing = true;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;
    const contentWidth = Math.max(20, width);
    const lines: string[] = [];
    const add = (text = "") => lines.push(truncateToWidth(text, contentWidth));
    add(this.theme.fg("accent", this.theme.bold("Qianji user task")));
    add(this.theme.fg("dim", compactPrompt(questionForRequest(this.request), contentWidth)));
    add("");
    for (const [index, choice] of choicesForInteraction(this.interaction).entries()) {
      const selected = index === this.optionIndex;
      const prefix = selected ? this.theme.fg("accent", ">") : " ";
      const labelText = choice.label || choice.value;
      const label = selected ? this.theme.fg("accent", this.theme.bold(labelText)) : labelText;
      const description = choice.description ? ` ${this.theme.fg("dim", choice.description)}` : "";
      add(`${prefix} ${label}${description}`);
    }
    if (this.editing) {
      add("");
      add(this.theme.fg("dim", this.interaction.freeText?.placeholder || "Answer:"));
      lines.push(...this.editor.render(contentWidth));
    }
    add("");
    add(this.theme.fg("dim", helpText(this.interaction, this.editing)));
    this.cachedLines = lines;
    return lines;
  }

  private get interaction(): QianjiInteraction {
    return this.request.interaction ?? { type: "input" };
  }

  private selectedChoice(): QianjiInteractionChoice | undefined {
    return choicesForInteraction(this.interaction)[this.optionIndex];
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

function choicesForInteraction(interaction: QianjiInteraction): QianjiInteractionChoice[] {
  if (interaction.choices?.length) return interaction.choices;
  if (interaction.type === "confirm") {
    return [
      { value: "approved", label: "Approve" },
      { value: "rejected", label: "Reject" },
    ];
  }
  return [];
}

function allowsFreeText(interaction: QianjiInteraction): boolean {
  return (
    interaction.type === "input" ||
    interaction.type === "choice_input" ||
    Boolean(interaction.freeText)
  );
}

function questionForRequest(request: PlannerReplyRequest): string {
  return request.interaction?.question || request.message || "(empty request)";
}

function helpText(interaction: QianjiInteraction, editing: boolean): string {
  if (editing) return "Enter submits. Escape cancels or returns to choices.";
  return allowsFreeText(interaction)
    ? "Up/Down navigate. Enter selects. Tab writes a custom answer. Escape cancels."
    : "Up/Down navigate. Enter selects. Escape cancels.";
}

function createEditorTheme(theme: PiTheme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      description: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("warning", text),
      scrollInfo: (text) => theme.fg("dim", text),
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
    },
  };
}

function compactPrompt(text: string, width: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const max = Math.max(40, width - 4);
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}
