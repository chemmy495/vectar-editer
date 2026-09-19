import { clonePath, reversePath } from '../core/path/path.ts';
import { simplifyPolyline } from '../core/trace/simplify.ts';
import { fitCurve } from '../core/trace/fit.ts';
import { subPathFromCubics } from '../core/path/build.ts';
import { rectanglePath } from '../core/path/shapes.ts';
import * as ops from '../core/model/ops.ts';
import * as query from '../core/model/query.ts';
import { createPathNode, type PathNode, type SceneNode } from '../core/model/node.ts';
import { cloneFill, cloneStroke } from '../core/model/style.ts';
import { flattenPath } from '../core/path/path.ts';
import type { Editor } from './editor.ts';

/** Reverses the direction of every selected path. */
export function reverseSelectedPaths(editor: Editor): void {
  const paths = editor.selectedNodes().filter((n): n is PathNode => n.type === 'path');
  if (paths.length === 0) {
    editor.setStatus('Select a path first');
    return;
  }
  editor.transaction('Reverse path', () => {
    for (const node of paths) {
      editor.run(ops.setPath(editor.document, node.id, reversePath(node.path), 'Reverse path'));
    }
  });
  editor.setStatus(`Reversed ${paths.length} path${paths.length === 1 ? '' : 's'}`);
}

/**
 * Reduces anchor count by flattening each subpath, simplifying the polyline
 * and refitting curves to it.
 */
export function simplifySelectedPaths(editor: Editor, tolerance = 1.5): void {
  const paths = editor.selectedNodes().filter((n): n is PathNode => n.type === 'path');
  if (paths.length === 0) {
    editor.setStatus('Select a path first');
    return;
  }

  let before = 0;
  let after = 0;
  editor.transaction('Simplify path', () => {
    for (const node of paths) {
      const rebuilt = clonePath(node.path);
      const polylines = flattenPath(node.path, 0.2);
      rebuilt.subpaths = rebuilt.subpaths
        .map((subpath, index) => {
          before += subpath.anchors.length;
          const points = simplifyPolyline(polylines[index] ?? [], tolerance);
          if (points.length < 2) return subpath;
          const cubics = fitCurve(points, tolerance);
          const fitted = subPathFromCubics(cubics, subpath.closed);
          if (!fitted || fitted.anchors.length < 2) return subpath;
          return fitted;
        })
        .filter((subpath) => subpath.anchors.length >= 2);
      for (const subpath of rebuilt.subpaths) after += subpath.anchors.length;
      editor.run(ops.setPath(editor.document, node.id, rebuilt, 'Simplify path'));
    }
  });
  editor.setStatus(`Simplified ${before} anchors down to ${after}`);
}

/**
 * Converts shapes that are not paths into paths. Text is not converted,
 * because that needs font outlines this editor does not parse.
 */
export function convertSelectionToPaths(editor: Editor): void {
  const nodes = editor.selectedNodes();
  const convertible = nodes.filter((node) => node.type === 'image');
  if (convertible.length === 0) {
    const hasText = nodes.some((node) => node.type === 'text');
    editor.setStatus(
      hasText
        ? 'Text cannot be converted to paths yet; export as SVG to keep it editable'
        : 'Nothing here needs converting',
    );
    return;
  }

  editor.transaction('Object to path', () => {
    for (const node of convertible) {
      if (node.type !== 'image') continue;
      const location = query.findNode(editor.document, node.id);
      if (!location) continue;
      // An image becomes its bounding rectangle, keeping position and transform.
      const replacement = createPathNode(
        rectanglePath({ x: node.x, y: node.y, width: node.width, height: node.height }),
        node.name,
      );
      replacement.transform = { ...node.transform };
      replacement.fill = cloneFill(editor.fill);
      replacement.stroke = cloneStroke(editor.stroke);
      editor.run(ops.removeNodes(editor.document, [node.id]));
      editor.run(ops.addNodes(editor.document, location.parent, [replacement as SceneNode], location.index));
    }
  });
}

/** Locks, unlocks, hides or shows nodes in bulk. */
export function setSelectionFlag(editor: Editor, key: 'locked' | 'visible', value: boolean): void {
  if (editor.selection.size === 0) return;
  editor.transaction(key === 'locked' ? 'Lock' : 'Hide', () => {
    editor.run(ops.patchNodes(editor.document, [...editor.selection], { [key]: value } as Partial<SceneNode>, 'Change'));
  });
  if (key === 'locked' && value) editor.clearSelection();
  if (key === 'visible' && !value) editor.clearSelection();
}

/** Clears the flag on every node in the document. */
export function clearFlagEverywhere(editor: Editor, key: 'locked' | 'visible', value: boolean): void {
  const ids: string[] = [];
  query.walk(editor.document, (node) => {
    if (node[key] !== value) ids.push(node.id);
  });
  if (ids.length === 0) return;
  editor.transaction(key === 'locked' ? 'Unlock all' : 'Show all', () => {
    editor.run(ops.patchNodes(editor.document, ids, { [key]: value } as Partial<SceneNode>, 'Change'));
  });
}

export function groupSelection(editor: Editor): void {
  if (editor.selection.size < 2) {
    editor.setStatus('Select at least two objects to group');
    return;
  }
  const result = ops.groupNodes(editor.document, [...editor.selection]);
  if (!result) return;
  editor.transaction('Group', () => editor.run(result.command));
  editor.setSelection([result.group.id]);
}

export function ungroupSelection(editor: Editor): void {
  const groups = editor.selectedNodes().filter((node) => node.type === 'group');
  if (groups.length === 0) {
    editor.setStatus('Select a group to ungroup');
    return;
  }
  const childIds = groups.flatMap((group) => (group.type === 'group' ? group.children.map((c) => c.id) : []));
  const command = ops.ungroupNodes(editor.document, groups.map((g) => g.id));
  if (!command) return;
  editor.transaction('Ungroup', () => editor.run(command));
  editor.setSelection(childIds);
}

export function reorderSelection(editor: Editor, action: ops.ZOrderAction): void {
  if (editor.selection.size === 0) return;
  editor.transaction('Reorder', () => {
    editor.run(ops.reorderNodes(editor.document, [...editor.selection], action));
  });
}
