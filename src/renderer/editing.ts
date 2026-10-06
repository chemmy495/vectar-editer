/**
 * High-level editing actions invoked from the menu and keyboard. Each one
 * applies immediately, building on the commands in `core/model/commands.ts`.
 */
import { clonePath, reversePath } from '../core/path/path.ts';
import { simplifyPolyline } from '../core/trace/simplify.ts';
import { fitCurve } from '../core/trace/fit.ts';
import { subPathFromCubics } from '../core/path/build.ts';
import { rectanglePath } from '../core/path/shapes.ts';
import * as commands from '../core/model/commands.ts';
import * as query from '../core/model/query.ts';
import { createPathNode, type PathNode, type SceneNode } from '../core/model/node.ts';
import { cloneFill, cloneStroke } from '../core/model/style.ts';
import { flattenPath } from '../core/path/path.ts';
import { translation } from '../core/geometry/matrix.ts';
import type { EditorContext } from './state/context.ts';

/**
 * Adds nodes to wherever new objects belong and selects them. Spans the
 * document and the selection, so it lives here rather than in either store.
 */
export function addNodes(editor: EditorContext, nodes: SceneNode[], label = 'Add object'): void {
  if (nodes.length === 0) return;
  const parent = editor.selection.insertionParent();
  editor.docs.transaction(label, () => {
    editor.docs.run(commands.addNodes(editor.docs.document, parent, nodes));
  });
  editor.selection.set(nodes.map((n) => n.id));
}

export function paste(editor: EditorContext): void {
  if (editor.clipboard.isEmpty) return;
  addNodes(editor, editor.clipboard.take(), 'Paste');
}

export function duplicate(editor: EditorContext): void {
  const copies = commands.duplicateNodes(editor.docs.document, [...editor.selection.ids]);
  if (copies.length === 0) return;
  // Offset the copies so they are visibly distinct from the originals.
  for (const copy of copies) {
    copy.transform = { ...copy.transform, e: copy.transform.e + 10, f: copy.transform.f + 10 };
  }
  addNodes(editor, copies, 'Duplicate');
}

export function deleteSelection(editor: EditorContext): void {
  if (editor.selection.size === 0) return;
  const ids = [...editor.selection.ids];
  editor.docs.transaction('Delete', () => {
    editor.docs.run(commands.removeNodes(editor.docs.document, ids));
  });
  editor.selection.clear();
}

/** Moves the selection by a fixed offset, for the arrow keys. */
export function nudgeSelection(editor: EditorContext, dx: number, dy: number): void {
  if (editor.selection.size === 0) return;
  editor.docs.transaction('Nudge', () => {
    editor.docs.run(commands.transformNodes(editor.docs.document, [...editor.selection.ids], translation(dx, dy)));
  });
}

/** Reverses the direction of every selected path. */
export function reverseSelectedPaths(editor: EditorContext): void {
  const paths = editor.selection.nodes().filter((n): n is PathNode => n.type === 'path');
  if (paths.length === 0) {
    editor.status.set('Select a path first');
    return;
  }
  editor.docs.transaction('Reverse path', () => {
    for (const node of paths) {
      editor.docs.run(commands.setPath(editor.docs.document, node.id, reversePath(node.path), 'Reverse path'));
    }
  });
  editor.status.set(`Reversed ${paths.length} path${paths.length === 1 ? '' : 's'}`);
}

/**
 * Reduces anchor count by flattening each subpath, simplifying the polyline
 * and refitting curves to it.
 */
export function simplifySelectedPaths(editor: EditorContext, tolerance = 1.5): void {
  const paths = editor.selection.nodes().filter((n): n is PathNode => n.type === 'path');
  if (paths.length === 0) {
    editor.status.set('Select a path first');
    return;
  }

  let before = 0;
  let after = 0;
  editor.docs.transaction('Simplify path', () => {
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
      editor.docs.run(commands.setPath(editor.docs.document, node.id, rebuilt, 'Simplify path'));
    }
  });
  editor.status.set(`Simplified ${before} anchors down to ${after}`);
}

/**
 * Converts shapes that are not paths into paths. Text is not converted,
 * because that needs font outlines this editor does not parse.
 */
export function convertSelectionToPaths(editor: EditorContext): void {
  const nodes = editor.selection.nodes();
  const convertible = nodes.filter((node) => node.type === 'image');
  if (convertible.length === 0) {
    const hasText = nodes.some((node) => node.type === 'text');
    editor.status.set(
      hasText
        ? 'Text cannot be converted to paths yet; export as SVG to keep it editable'
        : 'Nothing here needs converting',
    );
    return;
  }

  editor.docs.transaction('Object to path', () => {
    for (const node of convertible) {
      if (node.type !== 'image') continue;
      const location = query.findNode(editor.docs.document, node.id);
      if (!location) continue;
      // An image becomes its bounding rectangle, keeping position and transform.
      const replacement = createPathNode(
        rectanglePath({ x: node.x, y: node.y, width: node.width, height: node.height }),
        node.name,
      );
      replacement.transform = { ...node.transform };
      replacement.fill = cloneFill(editor.tools.fill);
      replacement.stroke = cloneStroke(editor.tools.stroke);
      editor.docs.run(commands.removeNodes(editor.docs.document, [node.id]));
      editor.docs.run(commands.addNodes(editor.docs.document, location.parent, [replacement as SceneNode], location.index));
    }
  });
}

/** Locks, unlocks, hides or shows nodes in bulk. */
export function setSelectionFlag(editor: EditorContext, key: 'locked' | 'visible', value: boolean): void {
  if (editor.selection.ids.size === 0) return;
  editor.docs.transaction(key === 'locked' ? 'Lock' : 'Hide', () => {
    editor.docs.run(commands.patchNodes(editor.docs.document, [...editor.selection.ids], { [key]: value } as Partial<SceneNode>, 'Change'));
  });
  if (key === 'locked' && value) editor.selection.clear();
  if (key === 'visible' && !value) editor.selection.clear();
}

/** Clears the flag on every node in the document. */
export function clearFlagEverywhere(editor: EditorContext, key: 'locked' | 'visible', value: boolean): void {
  const ids: string[] = [];
  query.walk(editor.docs.document, (node) => {
    if (node[key] !== value) ids.push(node.id);
  });
  if (ids.length === 0) return;
  editor.docs.transaction(key === 'locked' ? 'Unlock all' : 'Show all', () => {
    editor.docs.run(commands.patchNodes(editor.docs.document, ids, { [key]: value } as Partial<SceneNode>, 'Change'));
  });
}

export function groupSelection(editor: EditorContext): void {
  if (editor.selection.ids.size < 2) {
    editor.status.set('Select at least two objects to group');
    return;
  }
  const result = commands.groupNodes(editor.docs.document, [...editor.selection.ids]);
  if (!result) return;
  editor.docs.transaction('Group', () => editor.docs.run(result.command));
  editor.selection.set([result.group.id]);
}

export function ungroupSelection(editor: EditorContext): void {
  const groups = editor.selection.nodes().filter((node) => node.type === 'group');
  if (groups.length === 0) {
    editor.status.set('Select a group to ungroup');
    return;
  }
  const childIds = groups.flatMap((group) => (group.type === 'group' ? group.children.map((c) => c.id) : []));
  const command = commands.ungroupNodes(editor.docs.document, groups.map((g) => g.id));
  if (!command) return;
  editor.docs.transaction('Ungroup', () => editor.docs.run(command));
  editor.selection.set(childIds);
}

export function reorderSelection(editor: EditorContext, action: commands.ZOrderAction): void {
  if (editor.selection.ids.size === 0) return;
  editor.docs.transaction('Reorder', () => {
    editor.docs.run(commands.reorderNodes(editor.docs.document, [...editor.selection.ids], action));
  });
}
