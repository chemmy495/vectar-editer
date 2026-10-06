import { fromCorners } from '../../core/geometry/rect.ts';
import type { Vec } from '../../core/geometry/vec.ts';
import * as query from '../../core/model/query.ts';
import { paintColor, solidPaint } from '../../core/model/style.ts';

import type { CanvasView } from '../canvas.ts';
import { drawMarquee } from '../overlay.ts';
import type { Tool } from '../tool.ts';
import type { EditorContext } from '../state/context.ts';

/** Click to zoom in, Alt-click to zoom out, drag to zoom into a region. */
export function createZoomTool(editor: EditorContext, canvas: CanvasView): Tool {
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
      const dragged = area.width * editor.view.viewport.scale > 8 && area.height * editor.view.viewport.scale > 8;
      origin = null;
      current = null;

      if (dragged) editor.view.viewport.fit(area, 10);
      else editor.view.viewport.zoomAt(canvas.toScreenPoint(event), event.altKey ? 1 / 1.6 : 1.6);
      editor.events.emit('view');
    },

    drawOverlay(ctx) {
      if (!origin || !current) return;
      drawMarquee(ctx, fromCorners(editor.view.viewport.toScreen(origin), editor.view.viewport.toScreen(current)));
    },

    deactivate() {
      origin = null;
      current = null;
    },
  };
}

/** Picks the fill colour of the object under the cursor. */
export function createEyedropperTool(editor: EditorContext): Tool {
  return {
    id: 'eyedropper',
    cursor: 'crosshair',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      const hit = query.hitTest(editor.docs.document, point, {
        tolerance: editor.view.viewport.toDocumentLength(3),
        deep: true,
        measure: editor.measureText,
      });
      if (!hit || (hit.type !== 'path' && hit.type !== 'text')) {
        editor.status.set('Nothing to sample here');
        return;
      }
      // Alt samples the stroke colour instead of the fill.
      const source = event.altKey ? hit.stroke.paint : hit.fill.paint;
      const color = paintColor(source);
      if (!color) {
        editor.status.set('That object has no colour to sample');
        return;
      }
      if (event.altKey) editor.tools.setStroke({ ...editor.tools.stroke, paint: solidPaint(color) });
      else editor.tools.setFill({ ...editor.tools.fill, paint: solidPaint(color) });
      editor.status.set(`Picked ${event.altKey ? 'stroke' : 'fill'} colour`);
    },
  };
}

/** Drag to pan. Also reachable from any tool by holding space. */
export function createPanTool(editor: EditorContext, canvas: CanvasView): Tool {
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
      editor.view.viewport.panBy(event.clientX - last.x, event.clientY - last.y);
      last = { x: event.clientX, y: event.clientY };
      editor.events.emit('view');
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
