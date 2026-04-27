import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme as PiTheme,
} from "@mariozechner/pi-coding-agent";
import { createJiti } from "@mariozechner/jiti";
import { Key, matchesKey, type Component, type OverlayOptions, type TUI } from "@mariozechner/pi-tui";
import { withNativeWorkflowUiEscScope } from "./esc-scope.js";

const WORKFLOW_ASK_OVERLAY_MIN_WIDTH = 52;
const WORKFLOW_ASK_OVERLAY_MARGIN = 2;

export interface NativeAskOption {
  description?: string;
  label: string;
  value: string;
}

export interface NativeAskParams {
  questions: Array<{
    id: string;
    label?: string;
    options: NativeAskOption[];
    prompt: string;
    required?: boolean;
    type?: "single" | "multi" | "preview";
  }>;
  title?: string;
}

export interface NativeAskResultAnswer {
  customText?: string;
  labels?: string[];
  values?: string[];
}

export interface NativeAskResultDetails {
  answers?: Record<string, NativeAskResultAnswer>;
  cancelled?: boolean;
  error?: unknown;
}

export interface NativeAskToolResult {
  content?: Array<{ type: string; text?: string }>;
  details?: NativeAskResultDetails;
}

export type NativeAskFlow = (
  ctx: ExtensionCommandContext,
  params: NativeAskParams,
) => Promise<NativeAskResultDetails>;

type NativeAskCustomResult = NativeAskResultDetails;

type NativeAskCustomFactory = (
  tui: TUI,
  theme: PiTheme,
  keybindings: KeybindingsManager,
  done: (result: NativeAskCustomResult) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

type NativeAskCustomOptions = Parameters<ExtensionCommandContext["ui"]["custom"]>[1];

type PiAskControllerModule = {
  runAskFlow(
    ctx: ExtensionCommandContext,
    params: NativeAskParams,
  ): Promise<NativeAskResultDetails>;
};

let runAskFlowPromise: Promise<NativeAskFlow> | undefined;

export async function runNativePiAskFlow(
  ctx: ExtensionCommandContext,
  params: NativeAskParams,
): Promise<NativeAskResultDetails> {
  const runAskFlow = await loadPiAskRunAskFlow();
  return runAskFlow(ctx, params);
}

export async function runNativeWorkflowPiAskFlow(
  ctx: ExtensionCommandContext,
  params: NativeAskParams,
): Promise<NativeAskResultDetails> {
  const result = (await withNativeWorkflowUiEscScope(() =>
    runNativePiAskFlow(withWorkflowInputCancelKeys(ctx), params),
  )) as NativeAskResultDetails | undefined;
  return result ?? cancelledAskResult();
}

async function loadPiAskRunAskFlow(): Promise<NativeAskFlow> {
  runAskFlowPromise ??= importPiAskController().then((module) => module.runAskFlow);
  return runAskFlowPromise;
}

async function importPiAskController(): Promise<PiAskControllerModule> {
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: true,
    tryNative: false,
  });
  const module = await jiti.import<PiAskControllerModule>("@eko24ive/pi-ask/src/ui/controller.ts");
  if (typeof module.runAskFlow !== "function") {
    throw new Error("pi-ask dependency does not export runAskFlow");
  }
  return module;
}

function withWorkflowInputCancelKeys(ctx: ExtensionCommandContext): ExtensionCommandContext {
  return {
    ...ctx,
    ui: {
      ...ctx.ui,
      custom: (<T>(
        factory: NativeAskCustomFactory,
        options?: NativeAskCustomOptions,
      ): Promise<T> => {
        const customOptions = workflowAskCustomOptions(options);
        return ctx.ui.custom<NativeAskCustomResult>(async (tui, theme, keybindings, done) => {
          let completed = false;
          const complete = (result: NativeAskCustomResult) => {
            if (completed) return;
            completed = true;
            done(result);
          };
          const component = await factory(tui, theme, keybindings, complete);
          return withCancelKeyHandling(component, () => complete(cancelledAskResult()));
        }, customOptions) as Promise<T>;
      }) as ExtensionCommandContext["ui"]["custom"],
    },
  };
}

function workflowAskCustomOptions(
  options?: NativeAskCustomOptions,
): NativeAskCustomOptions {
  return {
    ...options,
    overlay: true,
    overlayOptions: options?.overlayOptions ?? workflowAskOverlayOptions(),
  };
}

function workflowAskOverlayOptions(): OverlayOptions {
  const margin = WORKFLOW_ASK_OVERLAY_MARGIN;
  return {
    anchor: "center",
    width: "80%",
    minWidth: WORKFLOW_ASK_OVERLAY_MIN_WIDTH,
    maxHeight: "80%",
    margin,
  };
}

function withCancelKeyHandling(
  component: Component & { dispose?(): void },
  cancel: () => void,
): Component & { dispose?(): void } {
  return {
    wantsKeyRelease: component.wantsKeyRelease,
    render: (width) => component.render(width),
    handleInput: (data) => {
      if (isWorkflowCancelKey(data)) {
        cancel();
        return;
      }
      component.handleInput?.(data);
    },
    invalidate: () => component.invalidate(),
    dispose: () => component.dispose?.(),
  };
}

function isWorkflowCancelKey(data: string): boolean {
  return matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
}

function cancelledAskResult(): NativeAskResultDetails {
  return {
    cancelled: true,
    answers: {},
  };
}
