import type { Vec } from '../../core/geometry/vec.ts';
import { brushStrokeToPath, pencilStrokeToPath, type StrokePoint } from '../../core/brush/stroke.ts';
import { createBrushNode, createStrokeNode } from '../../core/model/node.ts';
import { cloneFill, cloneStroke, defaultFill, defaultStroke } from '../../core/model/style.ts';
import { BLACK } from '../../core/model/color.ts';
import { tracePath } from '../../core/render/render.ts';
import { toCss } from '../../core/model/color.ts';
import { paintColor } from '../../core/model/style.ts';
import type { Editor, ToolId } from '../editor.ts';
import type { CanvasView } from '../canvas.ts';
import type { Tool } from '../tool.ts';

/**
 * Freehand drawing. The pencil produces a stroked centreline; the brush
 * produces a filled, pressure-varying outline.
 */
export function createFreehandTool(editor: Editor, canvas: CanvasView, mode: 'pencil' | 'brush'): Tool {
  let points: StrokePoint[] = [];
  let drawing = false;

  const pressureOf = (event: PointerEvent): number => {
    // Mice report 0 while down and 0.5 on some platforms; treat both as medium.
    if (event.pointerType === 'pen' && event.pressure > 0) return event.pressure;
    return 0.5;
  };

  const finish = () => {
    if (points.length === 0) {
      drawing = false;
      return;
    }
    const path =
      mode === 'brush'
        ? brushStrokeToPath(points, editor.brush)
        : pencilStrokeToPath(points, editor.brush.smoothing, Math.max(0.4, editor.brush.fitTolerance));

    points = [];
    drawing = false;

    if (path.subpaths.length === 0) {
      canvas.requestRender();
      return;
    }

    if (mode === 'brush') {
      const fill = editor.fill.paint.type === 'none' ? defaultFill(BLACK) : cloneFill(editor.fill);
      editor.addNodes([createBrushNode(path, fill, 'Brush stroke')], 'Brush stroke');
    } else {
      const stroke = editor.stroke.paint.type === 'none'
        ? defaultStroke(BLACK, Math.max(0.5, editor.brush.width / 4))
        : cloneStroke(editor.stroke);
      editor.addNodes([createStrokeNode(path, stroke, 'Pencil stroke')], 'Pencil stroke');
    }
  };

  return {
    id: mode as ToolId,
    cursor: 'crosshair',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      drawing = true;
      points = [{ x: point.x, y: point.y, pressure: pressureOf(event) }];
      canvas.requestRender();
    },

    onPointerMove(event, point) {
      if (!drawing) return;
      // Coalesced events keep fast strokes smooth on high-rate devices.
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      if (events.length > 1) {
        for (const sample of events) {
          const documentPoint = canvas.toDocumentPoint(sample);
          points.push({ x: documentPoint.x, y: documentPoint.y, pressure: pressureOf(sample) });
        }
      } else {
        points.push({ x: point.x, y: point.y, pressure: pressureOf(event) });
      }
      canvas.requestRender();
    },

    onPointerUp() {
      if (drawing) finish();
      canvas.requestRender();
    },

    onKeyDown(event) {
      if (event.key !== 'Escape' || !drawing) return false;
      points = [];
      drawing = false;
      canvas.requestRender();
      return true;
    },

    drawOverlay(ctx) {
      if (points.length === 0) return;
      const toScreen = (p: Vec) => editor.viewport.toScreen(p);

      if (mode === 'brush') {
        // Preview the real outline so width and pressure are visible live.
        const path = brushStrokeToPath(points, { ...editor.brush, fitTolerance: 0 });
        const color = paintColor(editor.fill.paint) ?? BLACK;
        ctx.save();
        ctx.fillStyle = toCss(color);
        ctx.beginPath();
        const screenPath = {
          subpaths: path.subpaths.map((subpath) => ({
            closed: subpath.closed,
            anchors: subpath.anchors.map((item) => ({
              point: toScreen(item.point),
              inHandle: { x: item.inHandle.x * editor.viewport.scale, y: item.inHandle.y * editor.viewport.scale },
              outHandle: { x: item.outHandle.x * editor.viewport.scale, y: item.outHandle.y * editor.viewport.scale },
              type: item.type,
            })),
          })),
        };
        tracePath(ctx, screenPath);
        ctx.fill('nonzero');
        ctx.restore();
        return;
      }

      const color = paintColor(editor.stroke.paint) ?? BLACK;
      ctx.save();
      ctx.strokeStyle = toCss(color);
      ctx.lineWidth = Math.max(1, editor.stroke.width * editor.viewport.scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const start = toScreen(points[0]);
      ctx.moveTo(start.x, start.y);
      for (let i = 1; i < points.length; i++) {
        const screen = toScreen(points[i]);
        ctx.lineTo(screen.x, screen.y);
      }
      ctx.stroke();
      ctx.restore();
    },

    deactivate() {
      if (drawing) finish();
    },
  };
}
