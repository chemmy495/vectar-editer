import { add, type Vec } from '../core/geometry/vec.ts';
import { compose, type Matrix } from '../core/geometry/matrix.ts';
import type { Rect } from '../core/geometry/rect.ts';
import * as query from '../core/model/query.ts';
import type { SceneNode } from '../core/model/node.ts';
import { segmentCount } from '../core/path/path.ts';
import type { Editor } from './editor.ts';
import { anchorKey } from './editor.ts';

export const HANDLE_SIZE = 8;
export const ROTATE_HANDLE_OFFSET = 22;

/** The eight scale handles plus the rotation handle. */
export type HandleId =
  | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

const ACCENT = '#4c9aff';
const ACCENT_SOFT = 'rgba(76, 154, 255, 0.18)';
const HANDLE_FILL = '#ffffff';

/** Screen positions of the transform handles around `bounds`. */
export function handlePositions(bounds: Rect): Record<HandleId, Vec> {
  const { x, y, width, height } = bounds;
  const midX = x + width / 2;
  const midY = y + height / 2;
  return {
    nw: { x, y },
    n: { x: midX, y },
    ne: { x: x + width, y },
    e: { x: x + width, y: midY },
    se: { x: x + width, y: y + height },
    s: { x: midX, y: y + height },
    sw: { x, y: y + height },
    w: { x, y: midY },
    rotate: { x: midX, y: y - ROTATE_HANDLE_OFFSET },
  };
}

export const CURSOR_FOR_HANDLE: Record<HandleId, string> = {
  nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
  se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
  rotate: 'grab',
};

/** The handle under a screen point, if any. */
export function hitHandle(bounds: Rect, point: Vec, tolerance = HANDLE_SIZE): HandleId | null {
  const positions = handlePositions(bounds);
  for (const [id, position] of Object.entries(positions) as Array<[HandleId, Vec]>) {
    if (Math.abs(point.x - position.x) <= tolerance && Math.abs(point.y - position.y) <= tolerance) return id;
  }
  return null;
}

function strokeRect(ctx: CanvasRenderingContext2D, bounds: Rect, color: string, dash: number[] = []): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.strokeRect(Math.round(bounds.x) + 0.5, Math.round(bounds.y) + 0.5, Math.round(bounds.width), Math.round(bounds.height));
  ctx.restore();
}

function drawHandle(ctx: CanvasRenderingContext2D, position: Vec, shape: 'square' | 'circle' | 'diamond', active: boolean): void {
  const half = HANDLE_SIZE / 2;
  ctx.save();
  ctx.fillStyle = active ? ACCENT : HANDLE_FILL;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(position.x, position.y, half, 0, Math.PI * 2);
  } else if (shape === 'diamond') {
    ctx.moveTo(position.x, position.y - half);
    ctx.lineTo(position.x + half, position.y);
    ctx.lineTo(position.x, position.y + half);
    ctx.lineTo(position.x - half, position.y);
    ctx.closePath();
  } else {
    ctx.rect(position.x - half, position.y - half, HANDLE_SIZE, HANDLE_SIZE);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Outlines a node's geometry in screen space, for selection feedback. */
export function outlineNode(ctx: CanvasRenderingContext2D, editor: Editor, node: SceneNode, world: Matrix, color: string): void {
  const bounds = query.localBounds(node, editor.measureText);
  if (!bounds) return;
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((corner) => editor.viewport.toScreen({
    x: world.a * corner.x + world.c * corner.y + world.e,
    y: world.b * corner.x + world.d * corner.y + world.f,
  }));

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  corners.forEach((corner, index) => (index === 0 ? ctx.moveTo(corner.x, corner.y) : ctx.lineTo(corner.x, corner.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/** The selection box with its scale and rotate handles. */
export function drawSelectionFrame(ctx: CanvasRenderingContext2D, bounds: Rect, activeHandle: HandleId | null): void {
  strokeRect(ctx, bounds, ACCENT);
  const positions = handlePositions(bounds);

  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(positions.n.x, positions.n.y);
  ctx.lineTo(positions.rotate.x, positions.rotate.y);
  ctx.stroke();
  ctx.restore();

  for (const [id, position] of Object.entries(positions) as Array<[HandleId, Vec]>) {
    drawHandle(ctx, position, id === 'rotate' ? 'circle' : 'square', id === activeHandle);
  }
}

export function drawMarquee(ctx: CanvasRenderingContext2D, area: Rect): void {
  ctx.save();
  ctx.fillStyle = ACCENT_SOFT;
  ctx.fillRect(area.x, area.y, area.width, area.height);
  ctx.restore();
  strokeRect(ctx, area, ACCENT, [4, 3]);
}

/** Anchors and bezier handles of a path being edited with the node tool. */
export function drawNodeEditingOverlay(ctx: CanvasRenderingContext2D, editor: Editor, node: SceneNode): void {
  if (node.type !== 'path') return;
  const world = compose(query.parentTransform(editor.document, node.id), node.transform);
  const toScreen = (point: Vec): Vec =>
    editor.viewport.toScreen({
      x: world.a * point.x + world.c * point.y + world.e,
      y: world.b * point.x + world.d * point.y + world.f,
    });

  const selected = editor.nodeSelection?.nodeId === node.id ? editor.nodeSelection.anchors : new Set<string>();

  // The path outline, so anchors read against the shape.
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const subpath of node.path.subpaths) {
    if (subpath.anchors.length === 0) continue;
    const start = toScreen(subpath.anchors[0].point);
    ctx.moveTo(start.x, start.y);
    const count = segmentCount(subpath);
    for (let i = 0; i < count; i++) {
      const from = subpath.anchors[i];
      const to = subpath.anchors[(i + 1) % subpath.anchors.length];
      const c1 = toScreen(add(from.point, from.outHandle));
      const c2 = toScreen(add(to.point, to.inHandle));
      const end = toScreen(to.point);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    }
    if (subpath.closed) ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();

  node.path.subpaths.forEach((subpath, subpathIndex) => {
    subpath.anchors.forEach((anchor, anchorIndex) => {
      const key = anchorKey(subpathIndex, anchorIndex);
      const isSelected = selected.has(key);
      const point = toScreen(anchor.point);

      // Handles are only shown for selected anchors, to keep the view readable.
      if (isSelected) {
        for (const handle of [anchor.inHandle, anchor.outHandle]) {
          if (handle.x === 0 && handle.y === 0) continue;
          const tip = toScreen(add(anchor.point, handle));
          ctx.save();
          ctx.strokeStyle = 'rgba(76, 154, 255, 0.8)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(point.x, point.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.restore();
          drawHandle(ctx, tip, 'circle', false);
        }
      }
      drawHandle(ctx, point, anchor.type === 'corner' ? 'square' : 'diamond', isSelected);
    });
  });
}

/** The page border and drop shadow around the document area. */
export function drawCanvasFrame(ctx: CanvasRenderingContext2D, editor: Editor): void {
  const bounds = editor.documentBounds();
  const topLeft = editor.viewport.toScreen({ x: bounds.x, y: bounds.y });
  const bottomRight = editor.viewport.toScreen({ x: bounds.width, y: bounds.height });
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.001)';
  ctx.fillRect(topLeft.x, topLeft.y, width, height);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width, height);
  ctx.restore();
}

/** Grid lines, drawn only when they would not be too dense to read. */
export function drawGrid(ctx: CanvasRenderingContext2D, editor: Editor): void {
  const spacing = editor.gridSize * editor.viewport.scale;
  if (spacing < 6) return;
  const area = editor.viewport.visibleArea();
  const startX = Math.floor(area.x / editor.gridSize) * editor.gridSize;
  const startY = Math.floor(area.y / editor.gridSize) * editor.gridSize;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= area.x + area.width; x += editor.gridSize) {
    const screenX = Math.round(editor.viewport.toScreen({ x, y: 0 }).x) + 0.5;
    ctx.moveTo(screenX, 0);
    ctx.lineTo(screenX, editor.viewport.height);
  }
  for (let y = startY; y <= area.y + area.height; y += editor.gridSize) {
    const screenY = Math.round(editor.viewport.toScreen({ x: 0, y }).y) + 0.5;
    ctx.moveTo(0, screenY);
    ctx.lineTo(editor.viewport.width, screenY);
  }
  ctx.stroke();
  ctx.restore();
}
