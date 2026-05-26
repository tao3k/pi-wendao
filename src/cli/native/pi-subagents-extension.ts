import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { registerPiWendaoNativeSubagents } from "../../subagents/index.js";

export const PI_WENDAO_RESET_NATIVE_SESSION_SURFACES_EVENT =
  "pi-wendao:native-session-surfaces:reset";

type ContextWithUi = (ExtensionCommandContext | ExtensionContext) & {
  ui: ExtensionCommandContext["ui"];
};

export default function registerPiWendaoPiSubagents(pi: ExtensionAPI): void {
  const overlayHandles = new Set<OverlayHandle>();
  let latestUi: ExtensionCommandContext["ui"] | undefined;
  let surfaceGeneration = 0;

  const resetSurfaces = () => {
    surfaceGeneration += 1;
    for (const handle of [...overlayHandles]) {
      handle.hide();
      overlayHandles.delete(handle);
    }
    latestUi?.setWidget("agents", undefined);
    latestUi?.setStatus("subagents", undefined);
  };

  pi.events.on(PI_WENDAO_RESET_NATIVE_SESSION_SURFACES_EVENT, resetSurfaces);

  registerPiWendaoNativeSubagents(
    wrapPi(pi, (ctx) =>
      wrapContext(ctx, overlayHandles, () => surfaceGeneration, (ui) => {
        latestUi = ui;
      }),
    ),
  );
}

function wrapPi(
  pi: ExtensionAPI,
  wrapCtx: <TContext extends ExtensionCommandContext | ExtensionContext>(ctx: TContext) => TContext,
): ExtensionAPI {
  return {
    ...pi,
    on: ((event: Parameters<ExtensionAPI["on"]>[0], handler: unknown) => {
      pi.on(event as never, ((payload: unknown, ctx: ExtensionContext) =>
        (handler as (payload: unknown, ctx: ExtensionContext) => unknown)(
          payload,
          wrapCtx(ctx),
        )) as never);
    }) as ExtensionAPI["on"],
    registerCommand: (name, options) => {
      pi.registerCommand(name, {
        ...options,
        handler: (args, ctx) => options.handler(args, wrapCtx(ctx)),
      });
    },
    registerTool: (tool) => {
      pi.registerTool(wrapTool(tool, wrapCtx));
    },
  };
}

function wrapTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  wrapCtx: <TContext extends ExtensionCommandContext | ExtensionContext>(ctx: TContext) => TContext,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        wrapUnknownContext(ctx, wrapCtx) as ExtensionContext,
      ),
  };
}

function wrapUnknownContext<TContext extends ExtensionCommandContext | ExtensionContext>(
  ctx: unknown,
  wrapCtx: (ctx: TContext) => TContext,
): unknown {
  return hasExtensionUi(ctx) ? wrapCtx(ctx as TContext) : ctx;
}

function wrapContext<TContext extends ExtensionCommandContext | ExtensionContext>(
  ctx: TContext,
  overlayHandles: Set<OverlayHandle>,
  getSurfaceGeneration: () => number,
  onUi: (ui: ExtensionCommandContext["ui"]) => void,
): TContext {
  if (!hasExtensionUi(ctx)) return ctx;
  const context = ctx as TContext & ContextWithUi;
  onUi(context.ui);
  const contextGeneration = getSurfaceGeneration();
  return {
    ...context,
    ui: {
      ...context.ui,
      custom: (<T>(
        factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0],
        options?: Parameters<ExtensionCommandContext["ui"]["custom"]>[1],
      ): Promise<T> => {
        let overlayHandle: OverlayHandle | undefined;
        const customOptions =
          options?.overlay === true
            ? {
                ...options,
                onHandle: (handle: OverlayHandle) => {
                  if (contextGeneration !== getSurfaceGeneration()) {
                    handle.hide();
                    return;
                  }
                  overlayHandle = handle;
                  overlayHandles.add(handle);
                  options.onHandle?.(handle);
                },
              }
            : options;
        return context.ui.custom<T>(
          factory as Parameters<typeof context.ui.custom<T>>[0],
          customOptions,
        ).finally(() => {
          if (overlayHandle) overlayHandles.delete(overlayHandle);
        });
      }) as ExtensionCommandContext["ui"]["custom"],
    },
  } as TContext;
}

function hasExtensionUi(value: unknown): value is ContextWithUi {
  return (
    typeof value === "object" &&
    value !== null &&
    "ui" in value &&
    typeof (value as { ui?: { custom?: unknown } }).ui?.custom === "function"
  );
}
