import { compose, rotation, scaling, translation, type Matrix } from '../../core/geometry/matrix.ts';
import { fromCorners, type Rect } from '../../core/geometry/rect.ts';
import type { Vec } from '../../core/geometry/vec.ts';
import * as commands from '../../core/model/commands.ts';
import type { Command } from '../../core/model/history.ts';
import * as query from '../../core/model/query.ts';
import type { NodeId } from '../../core/model/node.ts';

import type { CanvasView } from '../canvas.ts';
import { CURSOR_FOR_HANDLE, drawMarquee, drawSelectionFrame, hitHandle, type HandleId } from '../overlay.ts';
import type { Tool } from '../tool.ts';
import type { EditorContext } from '../state/context.ts';

type Gesture =
  | { kind: 'none' }
  | { kind: 'marquee'; origin: Vec; current: Vec; additive: boolean }
  | { kind: 'move'; origin: Vec; current: Vec; command: Command | null; ids: NodeId[] }
  | { kind: 'scale'; handle: HandleId; bounds: Rect; origin: Vec; current: Vec; command: Command | null; ids: NodeId[] }
  | { kind: 'rotate'; center: Vec; startAngle: number; current: number; command: Command | null; ids: NodeId[] };

/** Scale/rotate anchors opposite each handle, in normalized box coordinates. */
const OPPOSITE: Record<Exclude<HandleId, 'rotate'>, Vec> = {
  nw: { x: 1, y: 1 }, n: { x: 0.5, y: 1 }, ne: { x: 0, y: 1 }, e: { x: 0, y: 0.5 },
  se: { x: 0, y: 0 }, s: { x: 0.5, y: 0 }, sw: { x: 1, y: 0 }, w: { x: 1, y: 0.5 },
};

/**
 * The default tool: click to select, drag to move, drag the frame handles to
 * scale or rotate, and drag on empty canvas for a marquee.
 */
export function createSelectTool(editor: EditorContext, canvas: CanvasView): Tool {
  let gesture: Gesture = { kind: 'none' };

  const tolerance = () => editor.view.viewport.toDocumentLength(4);

  /** Live preview transform applied while a gesture is in flight. */
  const applyLive = (matrix: Matrix, ids: NodeId[], previous: Command | null): Command => {
    previous?.undo();
    const command = commands.transformNodes(editor.docs.document, ids, matrix);
    command.redo();
    editor.events.emit('document');
    return command;
  };

  const commit = (command: Command | null, label: string) => {
    if (!command) return;
    editor.docs.history.push({ label, redo: command.redo, undo: command.undo });
  };

  const scaleMatrix = (handle: Exclude<HandleId, 'rotate'>, bounds: Rect, delta: Vec, uniform: boolean): Matrix => {
    const anchorRatio = OPPOSITE[handle];
    const anchor = { x: bounds.x + bounds.width * anchorRatio.x, y: bounds.y + bounds.height * anchorRatio.y };
    const movesX = handle !== 'n' && handle !== 's';
    const movesY = handle !== 'e' && handle !== 'w';

    // Guard against a zero-size box, which would collapse the objects.
    const width = Math.max(1e-6, bounds.width);
    const height = Math.max(1e-6, bounds.height);
    const signX = anchorRatio.x === 1 ? -1 : 1;
    const signY = anchorRatio.y === 1 ? -1 : 1;

    let scaleX = movesX ? 1 + (delta.x * signX) / width : 1;
    let scaleY = movesY ? 1 + (delta.y * signY) / height : 1;
    if (uniform && movesX && movesY) {
      const uniformScale = Math.abs(scaleX) > Math.abs(scaleY) ? scaleX : scaleY;
      scaleX = uniformScale;
      scaleY = uniformScale;
    }
    return compose(translation(anchor.x, anchor.y), scaling(scaleX, scaleY), translation(-anchor.x, -anchor.y));
  };

  return {
    id: 'select',
    cursor: 'default',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      const bounds = editor.selection.bounds();
      const screen = canvas.toScreenPoint(event);

      if (bounds && editor.selection.ids.size > 0) {
        const screenBounds = toScreenRect(editor, bounds);
        const handle = hitHandle(screenBounds, screen);
        if (handle === 'rotate') {
          const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          gesture = {
            kind: 'rotate',
            center,
            startAngle: Math.atan2(point.y - center.y, point.x - center.x),
            current: 0,
            command: null,
            ids: [...editor.selection.ids],
          };
          return;
        }
        if (handle) {
          gesture = {
            kind: 'scale',
            handle,
            bounds,
            origin: point,
            current: point,
            command: null,
            ids: [...editor.selection.ids],
          };
          return;
        }
      }

      const hit = query.hitTest(editor.docs.document, point, { tolerance: tolerance(), measure: editor.measureText });
      if (!hit) {
        if (!event.shiftKey) editor.selection.clear();
        gesture = { kind: 'marquee', origin: point, current: point, additive: event.shiftKey };
        return;
      }

      if (event.shiftKey) editor.selection.toggle(hit.id);
      else if (!editor.selection.ids.has(hit.id)) editor.selection.set([hit.id]);

      if (editor.selection.ids.size > 0) {
        gesture = { kind: 'move', origin: point, current: point, command: null, ids: [...editor.selection.ids] };
      }
    },

    onPointerMove(event, point) {
      if (gesture.kind === 'none') {
        const bounds = editor.selection.bounds();
        const screen = canvas.toScreenPoint(event);
        if (bounds && editor.selection.ids.size > 0) {
          const handle = hitHandle(toScreenRect(editor, bounds), screen);
          if (handle) {
            canvas.updateCursor(CURSOR_FOR_HANDLE[handle]);
            canvas.setHovered(null);
            return;
          }
        }
        canvas.updateCursor();
        const hit = query.hitTest(editor.docs.document, point, { tolerance: tolerance(), measure: editor.measureText });
        canvas.setHovered(hit?.id ?? null);
        return;
      }

      if (gesture.kind === 'marquee') {
        gesture.current = point;
        canvas.requestRender();
        return;
      }

      if (gesture.kind === 'move') {
        gesture.current = point;
        const snapped = editor.view.snap({
          x: gesture.current.x - gesture.origin.x,
          y: gesture.current.y - gesture.origin.y,
        });
        // Shift constrains the drag to the dominant axis.
        const delta = event.shiftKey
          ? Math.abs(snapped.x) > Math.abs(snapped.y)
            ? { x: snapped.x, y: 0 }
            : { x: 0, y: snapped.y }
          : snapped;
        gesture.command = applyLive(translation(delta.x, delta.y), gesture.ids, gesture.command);
        return;
      }

      if (gesture.kind === 'scale') {
        gesture.current = point;
        const delta = { x: point.x - gesture.origin.x, y: point.y - gesture.origin.y };
        const matrix = scaleMatrix(gesture.handle as Exclude<HandleId, 'rotate'>, gesture.bounds, delta, event.shiftKey);
        gesture.command = applyLive(matrix, gesture.ids, gesture.command);
        return;
      }

      if (gesture.kind === 'rotate') {
        const angle = Math.atan2(point.y - gesture.center.y, point.x - gesture.center.x) - gesture.startAngle;
        // Shift snaps rotation to 15 degree steps.
        const snapped = event.shiftKey ? Math.round(angle / (Math.PI / 12)) * (Math.PI / 12) : angle;
        gesture.current = snapped;
        const matrix = compose(
          translation(gesture.center.x, gesture.center.y),
          rotation(snapped),
          translation(-gesture.center.x, -gesture.center.y),
        );
        gesture.command = applyLive(matrix, gesture.ids, gesture.command);
      }
    },

    onPointerUp(_event, _point) {
      switch (gesture.kind) {
        case 'marquee': {
          const area = fromCorners(gesture.origin, gesture.current);
          if (area.width > 1 || area.height > 1) {
            const found = query
              .nodesInRect(editor.docs.document, area, { strict: true, measure: editor.measureText })
              .map((node) => node.id);
            editor.selection.set(gesture.additive ? [...editor.selection.ids, ...found] : found);
          }
          break;
        }
        case 'move':
          commit(gesture.command, 'Move');
          break;
        case 'scale':
          commit(gesture.command, 'Scale');
          break;
        case 'rotate':
          commit(gesture.command, 'Rotate');
          break;
        default:
          break;
      }
      gesture = { kind: 'none' };
      canvas.requestRender();
    },

    onDoubleClick(_event, point) {
      // Double-click steps inside a group to select the object under the cursor.
      const deep = query.hitTest(editor.docs.document, point, { tolerance: tolerance(), deep: true, measure: editor.measureText });
      if (deep) editor.selection.set([deep.id]);
    },

    onKeyDown(event) {
      const step = event.shiftKey ? 10 : editor.view.snapToGrid ? editor.view.gridSize : 1;
      const nudges: Record<string, Vec> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      };
      const delta = nudges[event.key];
      if (!delta || editor.selection.ids.size === 0) return false;
      event.preventDefault();
      editor.docs.transaction('Nudge', () => {
        editor.docs.run(commands.transformNodes(editor.docs.document, [...editor.selection.ids], translation(delta.x, delta.y)));
      });
      return true;
    },

    drawOverlay(ctx) {
      if (gesture.kind === 'marquee') {
        const origin = editor.view.viewport.toScreen(gesture.origin);
        const current = editor.view.viewport.toScreen(gesture.current);
        drawMarquee(ctx, fromCorners(origin, current));
        return;
      }
      const bounds = editor.selection.bounds();
      if (!bounds || editor.selection.ids.size === 0) return;
      const active = gesture.kind === 'scale' ? gesture.handle : gesture.kind === 'rotate' ? 'rotate' : null;
      drawSelectionFrame(ctx, toScreenRect(editor, bounds), active);
    },

    deactivate() {
      if (gesture.kind === 'move' || gesture.kind === 'scale' || gesture.kind === 'rotate') {
        gesture.command?.undo();
      }
      gesture = { kind: 'none' };
    },
  };
}

/** Converts a document rectangle into screen pixels. */
export function toScreenRect(editor: EditorContext, bounds: Rect): Rect {
  const topLeft = editor.view.viewport.toScreen({ x: bounds.x, y: bounds.y });
  const bottomRight = editor.view.viewport.toScreen({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}
