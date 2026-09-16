import { compose, invert } from '../../core/geometry/matrix.ts';
import { add, dist, len, normalize, scale, sub, type Vec } from '../../core/geometry/vec.ts';
import { fromCorners } from '../../core/geometry/rect.ts';
import { clonePath, insertAnchor, nearestPoint, type PathData } from '../../core/path/path.ts';
import type { PathNode } from '../../core/model/node.ts';
import * as ops from '../../core/model/ops.ts';
import * as query from '../../core/model/query.ts';
import type { Command } from '../../core/model/history.ts';
import { anchorKey, parseAnchorKey, type Editor } from '../editor.ts';
import type { CanvasView } from '../canvas.ts';
import { drawMarquee } from '../overlay.ts';
import type { Tool } from '../tool.ts';

type Target = { subpath: number; anchor: number };
type HandleTarget = Target & { side: 'in' | 'out' };

type Gesture =
  | { kind: 'none' }
  | { kind: 'marquee'; origin: Vec; current: Vec; additive: boolean }
  | { kind: 'moveAnchors'; origin: Vec; before: PathData; targets: Target[] }
  | { kind: 'moveHandle'; origin: Vec; before: PathData; target: HandleTarget; mirror: boolean };

/**
 * Direct path editing: select anchors, drag them or their bezier handles,
 * add anchors by clicking the outline, and delete them with Delete.
 */
export function createNodeTool(editor: Editor, canvas: CanvasView): Tool {
  let gesture: Gesture = { kind: 'none' };

  const activePath = (): PathNode | null => {
    const node = editor.singleSelectedPath();
    return node && node.type === 'path' ? node : null;
  };

  /** Maps a document point into the active path's local coordinates. */
  const toLocal = (node: PathNode, point: Vec): Vec => {
    const world = compose(query.parentTransform(editor.document, node.id), node.transform);
    const inverse = invert(world);
    if (!inverse) return point;
    return { x: inverse.a * point.x + inverse.c * point.y + inverse.e, y: inverse.b * point.x + inverse.d * point.y + inverse.f };
  };

  const localTolerance = (node: PathNode): number => {
    const world = compose(query.parentTransform(editor.document, node.id), node.transform);
    const scaleFactor = Math.sqrt(Math.abs(world.a * world.d - world.b * world.c)) || 1;
    return editor.viewport.toDocumentLength(7) / scaleFactor;
  };

  const selectedKeys = (): Set<string> =>
    editor.nodeSelection?.anchors ?? new Set<string>();

  const setSelectedKeys = (node: PathNode, keys: Set<string>) => {
    editor.nodeSelection = { nodeId: node.id, anchors: keys };
    editor.emit('selection');
  };

  const findAnchorAt = (node: PathNode, local: Vec): Target | null => {
    const tolerance = localTolerance(node);
    for (let s = 0; s < node.path.subpaths.length; s++) {
      const subpath = node.path.subpaths[s];
      for (let a = 0; a < subpath.anchors.length; a++) {
        if (dist(subpath.anchors[a].point, local) <= tolerance) return { subpath: s, anchor: a };
      }
    }
    return null;
  };

  const findHandleAt = (node: PathNode, local: Vec): HandleTarget | null => {
    const tolerance = localTolerance(node);
    const keys = selectedKeys();
    for (const key of keys) {
      const { subpath, anchor } = parseAnchorKey(key);
      const target = node.path.subpaths[subpath]?.anchors[anchor];
      if (!target) continue;
      for (const side of ['in', 'out'] as const) {
        const handle = side === 'in' ? target.inHandle : target.outHandle;
        if (handle.x === 0 && handle.y === 0) continue;
        if (dist(add(target.point, handle), local) <= tolerance) return { subpath, anchor, side };
      }
    }
    return null;
  };

  const commitPath = (node: PathNode, before: PathData, label: string) => {
    const after = clonePath(node.path);
    const command: Command = {
      label,
      redo: () => {
        node.path = clonePath(after);
      },
      undo: () => {
        node.path = clonePath(before);
      },
    };
    editor.history.push(command);
  };

  /** Keeps smooth and symmetric anchors consistent after a handle moves. */
  const enforceAnchorType = (node: PathNode, target: HandleTarget) => {
    const anchor = node.path.subpaths[target.subpath]?.anchors[target.anchor];
    if (!anchor || anchor.type === 'corner') return;
    const moved = target.side === 'in' ? anchor.inHandle : anchor.outHandle;
    const otherKey = target.side === 'in' ? 'outHandle' : 'inHandle';
    const other = anchor[otherKey];
    const movedLength = len(moved);
    if (movedLength < 1e-9) return;
    const direction = scale(normalize(moved), -1);
    const otherLength = anchor.type === 'symmetric' ? movedLength : len(other);
    anchor[otherKey] = scale(direction, otherLength);
  };

  return {
    id: 'node',
    cursor: 'crosshair',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      const node = activePath();
      if (!node) {
        // Pick a path to edit first.
        const hit = query.hitTest(editor.document, point, { tolerance: editor.viewport.toDocumentLength(4), deep: true, measure: editor.measureText });
        if (hit && hit.type === 'path') editor.setSelection([hit.id]);
        else editor.clearSelection();
        return;
      }

      const local = toLocal(node, point);

      const handle = findHandleAt(node, local);
      if (handle) {
        gesture = {
          kind: 'moveHandle',
          origin: local,
          before: clonePath(node.path),
          target: handle,
          mirror: !event.altKey,
        };
        return;
      }

      const anchor = findAnchorAt(node, local);
      if (anchor) {
        const key = anchorKey(anchor.subpath, anchor.anchor);
        const keys = new Set(selectedKeys());
        if (event.shiftKey) {
          if (keys.has(key)) keys.delete(key);
          else keys.add(key);
        } else if (!keys.has(key)) {
          keys.clear();
          keys.add(key);
        }
        setSelectedKeys(node, keys);
        const targets = [...keys].map(parseAnchorKey).map((k) => ({ subpath: k.subpath, anchor: k.anchor }));
        gesture = { kind: 'moveAnchors', origin: local, before: clonePath(node.path), targets };
        return;
      }

      // Clicking the outline inserts a new anchor there.
      const near = nearestPoint(node.path, local);
      if (near && near.distance <= localTolerance(node)) {
        const before = clonePath(node.path);
        const updated = clonePath(node.path);
        updated.subpaths[near.subpath] = insertAnchor(updated.subpaths[near.subpath], near.index, near.t);
        node.path = updated;
        commitPath(node, before, 'Add anchor');
        setSelectedKeys(node, new Set([anchorKey(near.subpath, near.index + 1)]));
        editor.emit('document');
        return;
      }

      gesture = { kind: 'marquee', origin: point, current: point, additive: event.shiftKey };
      if (!event.shiftKey) setSelectedKeys(node, new Set());
    },

    onPointerMove(event, point) {
      const node = activePath();
      if (!node) return;

      if (gesture.kind === 'marquee') {
        gesture.current = point;
        canvas.requestRender();
        return;
      }

      if (gesture.kind === 'moveAnchors') {
        const local = toLocal(node, point);
        const delta = sub(local, gesture.origin);
        const constrained = event.shiftKey
          ? Math.abs(delta.x) > Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y }
          : delta;
        const updated = clonePath(gesture.before);
        for (const target of gesture.targets) {
          const anchor = updated.subpaths[target.subpath]?.anchors[target.anchor];
          if (anchor) anchor.point = add(anchor.point, constrained);
        }
        node.path = updated;
        editor.emit('document');
        return;
      }

      if (gesture.kind === 'moveHandle') {
        const local = toLocal(node, point);
        const updated = clonePath(gesture.before);
        const anchor = updated.subpaths[gesture.target.subpath]?.anchors[gesture.target.anchor];
        if (anchor) {
          const offset = sub(local, anchor.point);
          if (gesture.target.side === 'in') anchor.inHandle = offset;
          else anchor.outHandle = offset;
          node.path = updated;
          // Alt temporarily breaks the smooth/symmetric constraint.
          if (gesture.mirror) enforceAnchorType(node, gesture.target);
        }
        editor.emit('document');
      }
    },

    onPointerUp() {
      const node = activePath();
      if (!node) {
        gesture = { kind: 'none' };
        return;
      }

      if (gesture.kind === 'marquee') {
        const area = fromCorners(gesture.origin, gesture.current);
        if (area.width > 1 || area.height > 1) {
          const keys = gesture.additive ? new Set(selectedKeys()) : new Set<string>();
          const world = compose(query.parentTransform(editor.document, node.id), node.transform);
          node.path.subpaths.forEach((subpath, s) => {
            subpath.anchors.forEach((anchor, a) => {
              const worldPoint = {
                x: world.a * anchor.point.x + world.c * anchor.point.y + world.e,
                y: world.b * anchor.point.x + world.d * anchor.point.y + world.f,
              };
              if (
                worldPoint.x >= area.x && worldPoint.x <= area.x + area.width &&
                worldPoint.y >= area.y && worldPoint.y <= area.y + area.height
              ) {
                keys.add(anchorKey(s, a));
              }
            });
          });
          setSelectedKeys(node, keys);
        }
      } else if (gesture.kind === 'moveAnchors') {
        commitPath(node, gesture.before, 'Move anchors');
      } else if (gesture.kind === 'moveHandle') {
        commitPath(node, gesture.before, 'Move handle');
      }

      gesture = { kind: 'none' };
      canvas.requestRender();
    },

    onDoubleClick(_event, point) {
      // Double-clicking an anchor cycles its type.
      const node = activePath();
      if (!node) return;
      const local = toLocal(node, point);
      const target = findAnchorAt(node, local);
      if (!target) return;
      const before = clonePath(node.path);
      const updated = clonePath(node.path);
      const anchor = updated.subpaths[target.subpath].anchors[target.anchor];
      anchor.type = anchor.type === 'corner' ? 'smooth' : anchor.type === 'smooth' ? 'symmetric' : 'corner';
      if (anchor.type !== 'corner') {
        const direction = len(anchor.outHandle) > 0 ? anchor.outHandle : scale(anchor.inHandle, -1);
        if (len(direction) > 1e-9) {
          const unit = normalize(direction);
          const inLength = anchor.type === 'symmetric' ? Math.max(len(anchor.inHandle), len(anchor.outHandle)) : len(anchor.inHandle);
          const outLength = anchor.type === 'symmetric' ? inLength : len(anchor.outHandle);
          anchor.inHandle = scale(unit, -inLength);
          anchor.outHandle = scale(unit, outLength);
        }
      }
      node.path = updated;
      commitPath(node, before, 'Change anchor type');
      editor.emit('document');
    },

    onKeyDown(event) {
      const node = activePath();
      const keys = selectedKeys();
      if (!node || keys.size === 0) return false;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const before = clonePath(node.path);
        const updated = clonePath(node.path);
        // Remove from the end so earlier indices stay valid.
        const targets = [...keys].map(parseAnchorKey).sort((a, b) =>
          a.subpath === b.subpath ? b.anchor - a.anchor : b.subpath - a.subpath);
        for (const target of targets) {
          const subpath = updated.subpaths[target.subpath];
          if (subpath && subpath.anchors.length > 1) subpath.anchors.splice(target.anchor, 1);
        }
        updated.subpaths = updated.subpaths.filter((subpath) => subpath.anchors.length > 1);
        if (updated.subpaths.length === 0) {
          editor.transaction('Delete path', () => {
            editor.run(ops.removeNodes(editor.document, [node.id]));
          });
          editor.clearSelection();
          return true;
        }
        node.path = updated;
        commitPath(node, before, 'Delete anchors');
        setSelectedKeys(node, new Set());
        editor.emit('document');
        return true;
      }

      const step = event.shiftKey ? 10 : 1;
      const nudges: Record<string, Vec> = {
        ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
      };
      const delta = nudges[event.key];
      if (!delta) return false;
      event.preventDefault();
      const before = clonePath(node.path);
      const updated = clonePath(node.path);
      for (const key of keys) {
        const { subpath, anchor } = parseAnchorKey(key);
        const target = updated.subpaths[subpath]?.anchors[anchor];
        if (target) target.point = add(target.point, delta);
      }
      node.path = updated;
      commitPath(node, before, 'Nudge anchors');
      editor.emit('document');
      return true;
    },

    drawOverlay(ctx) {
      if (gesture.kind !== 'marquee') return;
      const origin = editor.viewport.toScreen(gesture.origin);
      const current = editor.viewport.toScreen(gesture.current);
      drawMarquee(ctx, fromCorners(origin, current));
    },

    deactivate() {
      gesture = { kind: 'none' };
    },
  };
}
