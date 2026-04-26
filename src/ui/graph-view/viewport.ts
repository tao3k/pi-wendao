import type { GraphNode, NodeBounds } from "./types.js";
import { clamp } from "./text.js";

export function resolveHorizontalOffset(options: {
  width: number;
  gridW: number;
  activeColumn: number;
  activeBounds?: NodeBounds;
  nodeBounds: NodeBounds[];
}): number {
  const maxOffset = Math.max(0, options.gridW - options.width);
  let offset = clamp(options.activeColumn - Math.floor(options.width / 2), 0, maxOffset);
  const bounds = options.activeBounds;
  if (bounds) {
    const padding = Math.min(2, Math.max(0, Math.floor((options.width - 1) / 4)));
    const left = Math.max(0, bounds.left - padding);
    const right = Math.min(options.gridW - 1, bounds.right + padding);
    if (right - left + 1 <= options.width) {
      if (left < offset) offset = left;
      if (offset + options.width - 1 < right) offset = right - options.width + 1;
    }
  }

  return avoidClippedNodeBoxes(
    clamp(offset, 0, maxOffset),
    options.width,
    maxOffset,
    options.nodeBounds,
    bounds,
  );
}

export function activeNodeBounds(
  nodes: Map<string, GraphNode>,
  nodeBounds: Map<string, NodeBounds>,
): NodeBounds | undefined {
  let bounds: NodeBounds | undefined;
  for (const [id, node] of nodes) {
    if (node.status === "active") bounds = nodeBounds.get(id);
  }
  return bounds;
}

function avoidClippedNodeBoxes(
  initialOffset: number,
  width: number,
  maxOffset: number,
  nodeBounds: NodeBounds[],
  activeBounds?: NodeBounds,
): number {
  let offset = initialOffset;
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    for (const bounds of nodeBounds) {
      if (sameBounds(bounds, activeBounds)) continue;
      const rightEdge = offset + width - 1;
      if (bounds.left < offset && offset <= bounds.right) {
        const candidate = clamp(bounds.right + 1, 0, maxOffset);
        if (keepsActiveVisible(candidate, width, activeBounds)) {
          offset = candidate;
          changed = true;
        }
      } else if (bounds.left <= rightEdge && rightEdge < bounds.right) {
        const candidate = clamp(bounds.left - width, 0, maxOffset);
        if (keepsActiveVisible(candidate, width, activeBounds)) {
          offset = candidate;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return offset;
}

function sameBounds(left: NodeBounds, right: NodeBounds | undefined): boolean {
  return !!right && left.left === right.left && left.right === right.right;
}

function keepsActiveVisible(
  offset: number,
  width: number,
  activeBounds: NodeBounds | undefined,
): boolean {
  if (!activeBounds) return true;
  return activeBounds.left >= offset && activeBounds.right <= offset + width - 1;
}
