import { compose, invert, multiply, type Matrix } from '../geometry/matrix.ts';
import { clonePath, type PathData } from '../path/path.ts';
import type { VectarDocument } from './document.ts';
import type { Command } from './history.ts';
import {
  cloneNode,
  createGroupNode,
  createLayerNode,
  isContainer,
  type ContainerNode,
  type LayerNode,
  type NodeId,
  type PathNode,
  type SceneNode,
} from './node.ts';
import { findNode, parentTransform } from './query.ts';

/** The container a node lives in: a group/layer, or the document's layer list. */
function childrenOf(doc: VectarDocument, parent: ContainerNode | null): SceneNode[] {
  return parent ? parent.children : (doc.layers as unknown as SceneNode[]);
}

/** Inserts `nodes` into `parent` at `index` (appending when index is omitted). */
export function addNodes(
  doc: VectarDocument,
  parent: ContainerNode | null,
  nodes: readonly SceneNode[],
  index?: number,
): Command {
  const list = nodes.slice();
  const target = childrenOf(doc, parent);
  const at = index === undefined ? target.length : Math.max(0, Math.min(index, target.length));
  return {
    label: list.length === 1 ? 'Add object' : 'Add objects',
    redo: () => {
      childrenOf(doc, parent).splice(at, 0, ...list);
    },
    undo: () => {
      childrenOf(doc, parent).splice(at, list.length);
    },
  };
}

type RemovedEntry = { node: SceneNode; parent: ContainerNode | null; index: number };

/** Removes nodes by id, remembering where each one was so undo can restore it. */
export function removeNodes(doc: VectarDocument, ids: readonly NodeId[]): Command {
  const entries: RemovedEntry[] = [];
  for (const id of ids) {
    const location = findNode(doc, id);
    if (location) entries.push({ node: location.node, parent: location.parent, index: location.index });
  }
  // Restoring from the lowest index first keeps the remembered indices valid.
  entries.sort((a, b) => a.index - b.index);

  return {
    label: entries.length === 1 ? 'Delete object' : 'Delete objects',
    redo: () => {
      for (const entry of entries) {
        const siblings = childrenOf(doc, entry.parent);
        const at = siblings.indexOf(entry.node);
        if (at >= 0) siblings.splice(at, 1);
      }
    },
    undo: () => {
      for (const entry of entries) {
        const siblings = childrenOf(doc, entry.parent);
        siblings.splice(Math.min(entry.index, siblings.length), 0, entry.node);
      }
    },
  };
}

/**
 * Applies `matrix` (expressed in document space) to each node, adjusting for
 * the node's parent transform so the visual result matches the drag.
 */
export function transformNodes(doc: VectarDocument, ids: readonly NodeId[], matrix: Matrix): Command {
  const entries: Array<{ node: SceneNode; before: Matrix; after: Matrix }> = [];
  for (const id of ids) {
    const location = findNode(doc, id);
    if (!location) continue;
    const parent = parentTransform(doc, id);
    const inverseParent = invert(parent);
    if (!inverseParent) continue;
    // world' = parent * after  and  world' = matrix * parent * before
    const after = compose(inverseParent, matrix, parent, location.node.transform);
    entries.push({ node: location.node, before: { ...location.node.transform }, after });
  }
  return {
    label: 'Transform',
    redo: () => {
      for (const e of entries) e.node.transform = { ...e.after };
    },
    undo: () => {
      for (const e of entries) e.node.transform = { ...e.before };
    },
  };
}

/** Sets a node's own transform outright. */
export function setTransform(doc: VectarDocument, id: NodeId, transform: Matrix): Command | null {
  const location = findNode(doc, id);
  if (!location) return null;
  const node = location.node;
  const before = { ...node.transform };
  const after = { ...transform };
  return {
    label: 'Transform',
    redo: () => {
      node.transform = { ...after };
    },
    undo: () => {
      node.transform = { ...before };
    },
  };
}

/** Shallow property patch that records the previous values for undo. */
export function patchNode<T extends SceneNode>(
  doc: VectarDocument,
  id: NodeId,
  patch: Partial<T>,
  label = 'Change property',
): Command | null {
  const location = findNode(doc, id);
  if (!location) return null;
  const node = location.node as T;
  const keys = Object.keys(patch) as Array<keyof T>;
  const before: Partial<T> = {};
  for (const key of keys) before[key] = node[key];
  const after: Partial<T> = { ...patch };
  return {
    label,
    redo: () => {
      for (const key of keys) node[key] = after[key] as T[keyof T];
    },
    undo: () => {
      for (const key of keys) node[key] = before[key] as T[keyof T];
    },
  };
}

/** Patches the same properties on several nodes in one step. */
export function patchNodes<T extends SceneNode>(
  doc: VectarDocument,
  ids: readonly NodeId[],
  patch: Partial<T>,
  label = 'Change property',
): Command {
  const commands = ids
    .map((id) => patchNode<T>(doc, id, patch, label))
    .filter((c): c is Command => c !== null);
  return {
    label,
    redo: () => commands.forEach((c) => c.redo()),
    undo: () => {
      for (let i = commands.length - 1; i >= 0; i--) commands[i].undo();
    },
  };
}

/** Replaces a path node's geometry. */
export function setPath(doc: VectarDocument, id: NodeId, path: PathData, label = 'Edit path'): Command | null {
  const location = findNode(doc, id);
  if (!location || location.node.type !== 'path') return null;
  const node = location.node as PathNode;
  const before = clonePath(node.path);
  const after = clonePath(path);
  return {
    label,
    redo: () => {
      node.path = clonePath(after);
    },
    undo: () => {
      node.path = clonePath(before);
    },
  };
}

export type ZOrderAction = 'front' | 'back' | 'forward' | 'backward';

/** Moves nodes within their own parent's child list. */
export function reorderNodes(doc: VectarDocument, ids: readonly NodeId[], action: ZOrderAction): Command {
  const snapshots: Array<{ parent: ContainerNode | null; before: SceneNode[]; after: SceneNode[] }> = [];
  const byParent = new Map<ContainerNode | null, SceneNode[]>();
  for (const id of ids) {
    const location = findNode(doc, id);
    if (!location) continue;
    const bucket = byParent.get(location.parent) ?? [];
    bucket.push(location.node);
    byParent.set(location.parent, bucket);
  }

  for (const [parent, moving] of byParent) {
    const siblings = childrenOf(doc, parent);
    const before = siblings.slice();
    const movingSet = new Set(moving);
    const rest = before.filter((n) => !movingSet.has(n));
    const ordered = before.filter((n) => movingSet.has(n));
    let after: SceneNode[];
    if (action === 'front') {
      after = [...rest, ...ordered];
    } else if (action === 'back') {
      after = [...ordered, ...rest];
    } else {
      after = before.slice();
      const step = action === 'forward' ? 1 : -1;
      const indices = ordered
        .map((n) => after.indexOf(n))
        .sort((a, b) => (step > 0 ? b - a : a - b));
      for (const index of indices) {
        const target = index + step;
        if (target < 0 || target >= after.length) continue;
        if (movingSet.has(after[target])) continue;
        const tmp = after[index];
        after[index] = after[target];
        after[target] = tmp;
      }
    }
    snapshots.push({ parent, before, after });
  }

  const label =
    action === 'front' ? 'Bring to front'
    : action === 'back' ? 'Send to back'
    : action === 'forward' ? 'Bring forward'
    : 'Send backward';

  return {
    label,
    redo: () => {
      for (const s of snapshots) {
        const siblings = childrenOf(doc, s.parent);
        siblings.length = 0;
        siblings.push(...s.after);
      }
    },
    undo: () => {
      for (const s of snapshots) {
        const siblings = childrenOf(doc, s.parent);
        siblings.length = 0;
        siblings.push(...s.before);
      }
    },
  };
}

/**
 * Wraps the given nodes in a new group placed where the topmost one was.
 * Child transforms are rebased so nothing moves on screen.
 */
export function groupNodes(doc: VectarDocument, ids: readonly NodeId[], name = 'Group'): { command: Command; group: ContainerNode } | null {
  const locations = ids
    .map((id) => findNode(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .filter((l) => l.node.type !== 'layer');
  if (locations.length === 0) return null;

  const parent = locations[0].parent;
  const siblings = childrenOf(doc, parent);
  // Keep document order so the group preserves the original stacking.
  const ordered = siblings.filter((n) => locations.some((l) => l.node === n));
  const insertAt = Math.min(...ordered.map((n) => siblings.indexOf(n)));

  const group = createGroupNode([], name);
  const rebased = new Map<SceneNode, { before: Matrix; after: Matrix }>();
  for (const node of ordered) {
    const location = findNode(doc, node.id)!;
    const fromParent = parentTransform(doc, node.id);
    // The group is created in `parent` space, so only nodes coming from a
    // different parent need their transform rebased.
    const toGroupParent = parentTransform(doc, ordered[0].id);
    const inverse = invert(toGroupParent);
    const after = inverse ? compose(inverse, fromParent, location.node.transform) : { ...location.node.transform };
    rebased.set(node, { before: { ...location.node.transform }, after });
  }

  const removals = removeNodes(doc, ordered.map((n) => n.id));

  return {
    group,
    command: {
      label: 'Group',
      redo: () => {
        removals.redo();
        group.children = ordered.slice();
        for (const node of ordered) {
          const entry = rebased.get(node);
          if (entry) node.transform = { ...entry.after };
        }
        const target = childrenOf(doc, parent);
        target.splice(Math.min(insertAt, target.length), 0, group);
      },
      undo: () => {
        const target = childrenOf(doc, parent);
        const at = target.indexOf(group);
        if (at >= 0) target.splice(at, 1);
        for (const node of ordered) {
          const entry = rebased.get(node);
          if (entry) node.transform = { ...entry.before };
        }
        group.children = [];
        removals.undo();
      },
    },
  };
}

/** Dissolves groups, lifting their children into the group's parent. */
export function ungroupNodes(doc: VectarDocument, ids: readonly NodeId[]): Command | null {
  const groups = ids
    .map((id) => findNode(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null && l.node.type === 'group');
  if (groups.length === 0) return null;

  const plans = groups.map((location) => {
    const group = location.node as ContainerNode;
    const children = group.children.slice();
    return {
      group,
      parent: location.parent,
      index: location.index,
      children,
      before: children.map((c) => ({ ...c.transform })),
      after: children.map((c) => multiply(group.transform, c.transform)),
    };
  });

  return {
    label: 'Ungroup',
    redo: () => {
      for (const plan of plans) {
        const siblings = childrenOf(doc, plan.parent);
        const at = siblings.indexOf(plan.group);
        if (at < 0) continue;
        plan.children.forEach((child, i) => {
          child.transform = { ...plan.after[i] };
        });
        siblings.splice(at, 1, ...plan.children);
        plan.group.children = [];
      }
    },
    undo: () => {
      for (let i = plans.length - 1; i >= 0; i--) {
        const plan = plans[i];
        const siblings = childrenOf(doc, plan.parent);
        const at = siblings.indexOf(plan.children[0]);
        const start = at >= 0 ? at : Math.min(plan.index, siblings.length);
        siblings.splice(start, plan.children.length);
        plan.children.forEach((child, k) => {
          child.transform = { ...plan.before[k] };
        });
        plan.group.children = plan.children.slice();
        siblings.splice(start, 0, plan.group);
      }
    },
  };
}

/** Moves nodes into `target` at `index`, preserving their on-screen position. */
export function reparentNodes(
  doc: VectarDocument,
  ids: readonly NodeId[],
  target: ContainerNode,
  index?: number,
): Command | null {
  const entries = ids
    .map((id) => findNode(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null && l.node.type !== 'layer')
    .filter((l) => l.node !== target && !isAncestor(l.node, target));
  if (entries.length === 0) return null;

  const targetWorld = worldTransformOf(doc, target);
  const inverseTarget = invert(targetWorld);

  const plans = entries.map((location) => {
    const world = compose(parentTransform(doc, location.node.id), location.node.transform);
    return {
      node: location.node,
      parent: location.parent,
      index: location.index,
      before: { ...location.node.transform },
      after: inverseTarget ? compose(inverseTarget, world) : { ...location.node.transform },
    };
  });
  plans.sort((a, b) => a.index - b.index);

  return {
    label: 'Move to layer',
    redo: () => {
      for (const plan of plans) {
        const siblings = childrenOf(doc, plan.parent);
        const at = siblings.indexOf(plan.node);
        if (at >= 0) siblings.splice(at, 1);
        plan.node.transform = { ...plan.after };
      }
      const at = index === undefined ? target.children.length : Math.max(0, Math.min(index, target.children.length));
      target.children.splice(at, 0, ...plans.map((p) => p.node));
    },
    undo: () => {
      for (const plan of plans) {
        const at = target.children.indexOf(plan.node);
        if (at >= 0) target.children.splice(at, 1);
      }
      for (const plan of plans) {
        plan.node.transform = { ...plan.before };
        const siblings = childrenOf(doc, plan.parent);
        siblings.splice(Math.min(plan.index, siblings.length), 0, plan.node);
      }
    },
  };
}

function isAncestor(candidate: SceneNode, node: SceneNode): boolean {
  if (!isContainer(candidate)) return false;
  for (const child of candidate.children) {
    if (child === node || isAncestor(child, node)) return true;
  }
  return false;
}

function worldTransformOf(doc: VectarDocument, node: SceneNode): Matrix {
  const location = findNode(doc, node.id);
  if (!location) return { ...node.transform };
  return compose(...location.ancestors.map((a) => a.transform), node.transform);
}

export function addLayer(doc: VectarDocument, name?: string, index?: number): { command: Command; layer: LayerNode } {
  const layer = createLayerNode(name ?? `Layer ${doc.layers.length + 1}`);
  const at = index === undefined ? doc.layers.length : Math.max(0, Math.min(index, doc.layers.length));
  return {
    layer,
    command: {
      label: 'Add layer',
      redo: () => {
        doc.layers.splice(at, 0, layer);
      },
      undo: () => {
        const found = doc.layers.indexOf(layer);
        if (found >= 0) doc.layers.splice(found, 1);
      },
    },
  };
}

/** Removes a layer. The last remaining layer is kept so the document is usable. */
export function removeLayer(doc: VectarDocument, id: NodeId): Command | null {
  if (doc.layers.length <= 1) return null;
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) return null;
  const layer = doc.layers[index];
  return {
    label: 'Delete layer',
    redo: () => {
      const at = doc.layers.indexOf(layer);
      if (at >= 0) doc.layers.splice(at, 1);
    },
    undo: () => {
      doc.layers.splice(Math.min(index, doc.layers.length), 0, layer);
    },
  };
}

export function moveLayer(doc: VectarDocument, id: NodeId, toIndex: number): Command | null {
  const from = doc.layers.findIndex((l) => l.id === id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(toIndex, doc.layers.length - 1));
  if (from === to) return null;
  return {
    label: 'Reorder layers',
    redo: () => {
      const [layer] = doc.layers.splice(from, 1);
      doc.layers.splice(to, 0, layer);
    },
    undo: () => {
      const [layer] = doc.layers.splice(to, 1);
      doc.layers.splice(from, 0, layer);
    },
  };
}

/** Copies nodes with fresh ids, ready to paste. */
export function duplicateNodes(doc: VectarDocument, ids: readonly NodeId[]): SceneNode[] {
  return ids
    .map((id) => findNode(doc, id))
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .map((l) => cloneNode(l.node, true));
}

export { childrenOf };
