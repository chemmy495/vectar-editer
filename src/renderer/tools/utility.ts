import { fromCorners } from '../../core/geometry/rect.ts';
import type { Vec } from '../../core/geometry/vec.ts';
import * as query from '../../core/model/query.ts';
import { paintColor, solidPaint } from '../../core/model/style.ts';
import type { Editor } from '../editor.ts';
import type { CanvasView } from '../canvas.ts';
import { drawMarquee } from '../overlay.ts';
import type { Tool } from '../tool.ts';

/** Click to zoom in, Alt-click to zoom out, drag to zoom into a region. */
export function createZoomTool(editor: Editor, canvas: CanvasView): Tool {
  let origin: Vec | null = null;
  let current: Vec | null = null;

  return {
    id: 'zoom',
    cursor: 'zoom-in',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      origin = point;
      current = point;
    },

    onPointerMove(_event, point) {
      if (!origin) return;
      current = point;
      canvas.requestRender();
    },

    onPointerUp(event, point) {
      if (!origin) return;
      const area = fromCorners(origin, current ?? point);
      const dragged = area.width * editor.viewport.scale > 8 && area.height * editor.viewport.scale > 8;
      origin = null;
      current = null;

      if (dragged) editor.viewport.fit(area, 10);
      else editor.viewport.zoomAt(canvas.toScreenPoint(event), event.altKey ? 1 / 1.6 : 1.6);
      editor.emit('view');
    },

    drawOverlay(ctx) {
      if (!origin || !current) return;
      drawMarquee(ctx, fromCorners(editor.viewport.toScreen(origin), editor.viewport.toScreen(current)));
    },

    deactivate() {
      origin = null;
      current = null;
    },
  };
}

/** Picks the fill colour of the object under the cursor. */
export function createEyedropperTool(editor: Editor): Tool {
  return {
    id: 'eyedropper',
    cursor: 'crosshair',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      const hit = query.hitTest(editor.document, point, {
        tolerance: editor.viewport.toDocumentLength(3),
        deep: true,
        measure: editor.measureText,
      });
      if (!hit || (hit.type !== 'path' && hit.type !== 'text')) {
        editor.setStatus('Nothing to sample here');
        return;
      }
      // Alt samples the stroke colour instead of the fill.
      const source = event.altKey ? hit.stroke.paint : hit.fill.paint;
      const color = paintColor(source);
      if (!color) {
        editor.setStatus('That object has no colour to sample');
        return;
      }
      if (event.altKey) editor.setStroke({ ...editor.stroke, paint: solidPaint(color) });
      else editor.setFill({ ...editor.fill, paint: solidPaint(color) });
      editor.setStatus(`Picked ${event.altKey ? 'stroke' : 'fill'} colour`);
    },
  };
}

/** Drag to pan. Also reachable from any tool by holding space. */
export function createPanTool(editor: Editor, canvas: CanvasView): Tool {
  let last: { x: number; y: number } | null = null;

  return {
    id: 'pan',
    cursor: 'grab',

    onPointerDown(event) {
      if (event.button !== 0) return;
      last = { x: event.clientX, y: event.clientY };
      canvas.updateCursor('grabbing');
    },

    onPointerMove(event) {
      if (!last) return;
      editor.viewport.panBy(event.clientX - last.x, event.clientY - last.y);
      last = { x: event.clientX, y: event.clientY };
      editor.emit('view');
    },

    onPointerUp() {
      last = null;
      canvas.updateCursor();
    },

    deactivate() {
      last = null;
    },
  };
}
