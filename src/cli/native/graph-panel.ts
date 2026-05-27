import { basename } from "node:path";
import type { ExtensionCommandContext, Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type OverlayHandle,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { GraphView } from "../../ui/graph-view.js";

interface NativeWorkflowGraphComponent extends Component {
  dispose?(): void;
  requestRender?(): void;
}

interface NativeWorkflowRendererLike {
  graphView: GraphView;
  workflowPath: string;
}

export type NativeWorkflowWidgetHandle = Component & { dispose(): void; requestRender(): void };

export interface NativeWorkflowGraphPanelHandle {
  close(): void;
  requestRender(): void;
}

const activeGraphPanels = new Set<NativeWorkflowGraphPanelHandle>();

export function setNativeWorkflowGraphPanel(
  ctx: Pick<ExtensionCommandContext, "ui">,
  factory: (tui: TUI, theme: PiTheme) => NativeWorkflowGraphComponent,
): NativeWorkflowGraphPanelHandle {
  let component: NativeWorkflowGraphComponent | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let closed = false;

  void ctx.ui
    .custom<void>(
      (tui, theme) => {
        component = factory(tui, theme);
        if (closed) {
          component.dispose?.();
        }
        return component;
      },
      {
        overlay: true,
        overlayOptions: () => ({
          anchor: "top-center",
          width: "100%",
          maxHeight: "42%",
          row: 0,
          col: 0,
          margin: { top: 0, right: 0, left: 0 },
          nonCapturing: true,
          visible: (termWidth, termHeight) => termWidth >= 20 && termHeight >= 10,
        }),
        onHandle: (handle) => {
          overlayHandle = handle;
          if (closed) handle.hide();
        },
      },
    )
    .catch(() => undefined);

  const panel: NativeWorkflowGraphPanelHandle = {
    close: () => {
      if (closed) return;
      closed = true;
      activeGraphPanels.delete(panel);
      overlayHandle?.hide();
      component?.dispose?.();
    },
    requestRender: () => {
      component?.invalidate();
      component?.requestRender?.();
    },
  };
  activeGraphPanels.add(panel);
  return panel;
}

export function clearNativeWorkflowGraphPanel(
  panel: NativeWorkflowGraphPanelHandle | undefined,
): void {
  panel?.close();
}

export function clearAllNativeWorkflowGraphPanels(): void {
  for (const panel of activeGraphPanels) {
    panel.close();
  }
}

export function createNativeWorkflowWidget(
  renderer: NativeWorkflowRendererLike,
  tui: TUI,
  theme: PiTheme,
): NativeWorkflowWidgetHandle {
  return new NativeWorkflowWidget(renderer, tui, theme);
}

export function renderTopGraphWidgetLines(options: {
  graphView: GraphView;
  title: string;
  width: number;
  terminalRows: number;
  truncate: (text: string, width: number) => string;
}): string[] {
  if (options.width < 10) return [];
  const totalHeight = Math.max(6, Math.min(18, Math.floor(options.terminalRows * 0.42)));
  const title = options.truncate(options.title, options.width);
  const graphLines = options.graphView.render(options.width);
  const availableGraphHeight = totalHeight - 1;
  const graphHeight =
    graphLines.length === 0 ? 0 : Math.max(3, Math.min(graphLines.length, availableGraphHeight));
  const graphStart = Math.max(
    0,
    Math.min(
      options.graphView.getActiveRow() - Math.floor(graphHeight / 2),
      Math.max(0, graphLines.length - graphHeight),
    ),
  );
  const visibleGraph = graphLines.slice(graphStart, graphStart + graphHeight);
  const topPadding =
    graphLines.length < availableGraphHeight
      ? Math.floor((availableGraphHeight - graphLines.length) / 2)
      : 0;
  return [title, ...Array.from({ length: topPadding }, () => ""), ...visibleGraph].slice(
    0,
    totalHeight,
  );
}

class NativeWorkflowWidget implements Component {
  private invalidated = false;

  constructor(
    private readonly renderer: NativeWorkflowRendererLike,
    private readonly tui: TUI,
    private readonly theme: PiTheme,
  ) {}

  invalidate(): void {
    this.invalidated = true;
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.invalidated = false;
    return renderTopGraphWidgetLines({
      graphView: this.renderer.graphView,
      title: `${this.theme.bold(this.theme.fg("accent", "pi-wendao workflow"))} ${this.theme.fg("dim", basename(this.renderer.workflowPath))}`,
      width,
      terminalRows: this.tui.terminal.rows,
      truncate: truncateToWidth,
    });
  }

  dispose(): void {
    this.invalidated = true;
  }
}
