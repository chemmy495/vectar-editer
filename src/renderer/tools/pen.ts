import { add, dist, neg, sub, type Vec } from '../../core/geometry/vec.ts';
import { anchor, type Anchor, type PathData } from '../../core/path/path.ts';
import { createPathNode } from '../../core/model/node.ts';
import { cloneFill, cloneStroke, defaultStroke, noFill } from '../../core/model/style.ts';
import { BLACK } from '../../core/model/color.ts';
import type { Editor } from '../editor.ts';
import type { CanvasView } from '../canvas.ts';
import type { Tool } from '../tool.ts';

/**
 * Bezier pen. Click to place a corner anchor, drag to pull out symmetric
 * handles, click the first anchor to close, Enter or Escape to finish.
 */
export function createPenTool(editor: Editor, canvas: CanvasView): Tool {
  let anchors: Anchor[] = [];
  let dragging = false;
  let cursor: Vec | null = null;

  const reset = () => {
    anchors = [];
    dragging = false;
    cursor = null;
  };

  const previewPath = (closed: boolean): PathData => ({
    subpaths: anchors.length > 0 ? [{ anchors: anchors.map((a) => ({ ...a })), closed }] : [],
  });

  /** Turns the pending anchors into a real path node. */
  const commit = (closed: boolean) => {
    if (anchors.length < 2) {
      reset();
      canvas.requestRender();
      return;
    }
    const node = createPathNode(previewPath(closed), 'Path');
    node.fill = closed ? cloneFill(editor.fill) : noFill();
    node.stroke = editor.stroke.paint.type === 'none' && !closed
      ? defaultStroke(BLACK, 1)
      : cloneStroke(editor.stroke);
    editor.addNodes([node], 'Draw path');
    reset();
    editor.setTool('select');
  };

  return {
    id: 'pen',
    cursor: 'crosshair',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      const snapped = editor.snap(point);

      // Clicking the first anchor closes the path.
      if (anchors.length > 1 && dist(snapped, anchors[0].point) <= editor.viewport.toDocumentLength(8)) {
        commit(true);
        return;
      }
      anchors.push(anchor(snapped));
      dragging = true;
      canvas.requestRender();
    },

    onPointerMove(_event, point) {
      cursor = point;
      if (dragging && anchors.length > 0) {
        const current = anchors[anchors.length - 1];
        const handle = sub(point, current.point);
        current.outHandle = handle;
        current.inHandle = neg(handle);
        current.type = 'symmetric';
      }
      canvas.requestRender();
    },

    onPointerUp() {
      dragging = false;
    },

    onDoubleClick() {
      commit(false);
    },

    onKeyDown(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(false);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        reset();
        canvas.requestRender();
        return true;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && anchors.length > 0) {
        event.preventDefault();
        anchors.pop();
        canvas.requestRender();
        return true;
      }
      return false;
    },

    drawOverlay(ctx) {
      if (anchors.length === 0) return;
      const toScreen = (p: Vec) => editor.viewport.toScreen(p);

      ctx.save();
      ctx.strokeStyle = '#4c9aff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const start = toScreen(anchors[0].point);
      ctx.moveTo(start.x, start.y);
      for (let i = 1; i < anchors.length; i++) {
        const from = anchors[i - 1];
        const to = anchors[i];
        const c1 = toScreen(add(from.point, from.outHandle));
        const c2 = toScreen(add(to.point, to.inHandle));
        const end = toScreen(to.point);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
      }
      // The rubber-band segment to the cursor.
      if (cursor) {
        const last = anchors[anchors.length - 1];
        const c1 = toScreen(add(last.point, last.outHandle));
        const end = toScreen(cursor);
        ctx.bezierCurveTo(c1.x, c1.y, end.x, end.y, end.x, end.y);
      }
      ctx.stroke();

      for (const item of anchors) {
        const screen = toScreen(item.point);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#4c9aff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(screen.x - 3.5, screen.y - 3.5, 7, 7);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },

    deactivate() {
      reset();
    },
  };
}
