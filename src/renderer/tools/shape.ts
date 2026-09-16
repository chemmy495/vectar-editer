import { fromCorners, type Rect } from '../../core/geometry/rect.ts';
import type { Vec } from '../../core/geometry/vec.ts';
import { ellipsePath, linePath, polygonPath, rectanglePath, starPath } from '../../core/path/shapes.ts';
import type { PathData } from '../../core/path/path.ts';
import { createPathNode } from '../../core/model/node.ts';
import { cloneFill, cloneStroke, defaultStroke, noFill } from '../../core/model/style.ts';
import { BLACK } from '../../core/model/color.ts';
import type { Editor, ToolId } from '../editor.ts';
import type { CanvasView } from '../canvas.ts';
import type { Tool } from '../tool.ts';

export type ShapeKind = 'rect' | 'ellipse' | 'polygon' | 'star' | 'line';

const LABELS: Record<ShapeKind, string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line',
};

/** Drag-to-draw primitives. Shift constrains, Alt draws from the centre. */
export function createShapeTool(editor: Editor, canvas: CanvasView, kind: ShapeKind): Tool {
  let origin: Vec | null = null;
  let current: Vec | null = null;
  let fromCenter = false;
  let constrained = false;

  const area = (): Rect => {
    if (!origin || !current) return { x: 0, y: 0, width: 0, height: 0 };
    let end = current;
    if (constrained && kind !== 'line') {
      const size = Math.max(Math.abs(end.x - origin.x), Math.abs(end.y - origin.y));
      end = {
        x: origin.x + Math.sign(end.x - origin.x || 1) * size,
        y: origin.y + Math.sign(end.y - origin.y || 1) * size,
      };
    }
    if (fromCenter) {
      return fromCorners({ x: origin.x - (end.x - origin.x), y: origin.y - (end.y - origin.y) }, end);
    }
    return fromCorners(origin, end);
  };

  const geometry = (): PathData | null => {
    if (!origin || !current) return null;
    if (kind === 'line') {
      let end = current;
      if (constrained) {
        // Snap the line to 15 degree increments.
        const dx = end.x - origin.x;
        const dy = end.y - origin.y;
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        const length = Math.hypot(dx, dy);
        end = { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
      }
      return linePath(origin, end);
    }
    const box = area();
    if (box.width < 1e-6 || box.height < 1e-6) return null;
    switch (kind) {
      case 'rect':
        return rectanglePath(box, editor.shapeDefaults.cornerRadius);
      case 'ellipse':
        return ellipsePath(box);
      case 'polygon':
        return polygonPath(box, editor.shapeDefaults.polygonSides);
      case 'star':
        return starPath(box, editor.shapeDefaults.starPoints, editor.shapeDefaults.starInnerRatio);
    }
  };

  const reset = () => {
    origin = null;
    current = null;
  };

  return {
    id: kind as ToolId,
    cursor: 'crosshair',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      origin = editor.snap(point);
      current = origin;
      fromCenter = event.altKey;
      constrained = event.shiftKey;
      canvas.requestRender();
    },

    onPointerMove(event, point) {
      if (!origin) return;
      current = editor.snap(point);
      fromCenter = event.altKey;
      constrained = event.shiftKey;
      canvas.requestRender();
    },

    onPointerUp() {
      const path = geometry();
      reset();
      if (!path) {
        canvas.requestRender();
        return;
      }
      const node = createPathNode(path, LABELS[kind]);
      if (kind === 'line') {
        node.fill = noFill();
        node.stroke = editor.stroke.paint.type === 'none' ? defaultStroke(BLACK, 1) : cloneStroke(editor.stroke);
      } else {
        node.fill = cloneFill(editor.fill);
        node.stroke = cloneStroke(editor.stroke);
      }
      editor.addNodes([node], `Draw ${LABELS[kind].toLowerCase()}`);
    },

    onKeyDown(event) {
      if (event.key !== 'Escape' || !origin) return false;
      reset();
      canvas.requestRender();
      return true;
    },

    drawOverlay(ctx) {
      if (!origin || !current) return;
      ctx.save();
      ctx.strokeStyle = '#4c9aff';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      if (kind === 'line') {
        const a = editor.viewport.toScreen(origin);
        const b = editor.viewport.toScreen(current);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      } else {
        const box = area();
        const topLeft = editor.viewport.toScreen({ x: box.x, y: box.y });
        const bottomRight = editor.viewport.toScreen({ x: box.x + box.width, y: box.y + box.height });
        ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      }
      ctx.restore();
    },

    deactivate() {
      reset();
    },
  };
}
