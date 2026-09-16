import { applyToPoint, compose, invert, meanScale, type Matrix } from '../geometry/matrix.ts';
import { identity } from '../geometry/matrix.ts';
import * as R from '../geometry/rect.ts';
import type { Rect } from '../geometry/rect.ts';
import type { Vec } from '../geometry/vec.ts';
import * as P from '../path/path.ts';
import type { VectarDocument } from './document.ts';
import { isContainer, type ContainerNode, type NodeId, type SceneNode, type TextNode } from './node.ts';
import { isFillVisible, isStrokeVisible } from './style.ts';

/** Where a node sits in the tree. `parent` is null for top-level layers. */
export type NodeLocation = {
  node: SceneNode;
  parent: ContainerNode | null;
  index: number;
  /** Outermost first, excluding the node itself. */
  ancestors: ContainerNode[];
};

/** Measures a text node's box in its own local coordinates. */
export type TextMeasurer = (node: TextNode) => Rect;

/**
 * Rough text metrics for contexts without a canvas (tests, the main process).
 * The renderer replaces this with real measurement.
 */
export const estimateTextBounds: TextMeasurer = (node) => {
  const lines = node.text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const width = longest * node.fontSize * 0.55 + Math.max(0, longest - 1) * node.letterSpacing;
  const height = Math.max(1, lines.length) * node.fontSize * node.lineHeight;
  const offsetX = node.align === 'middle' ? -width / 2 : node.align === 'end' ? -width : 0;
  return { x: node.x + offsetX, y: node.y - node.fontSize * 0.8, width, height };
};

/** Depth-first walk over every node, children after their parent. */
export function walk(doc: VectarDocument, visit: (node: SceneNode, parent: ContainerNode | null) => void): void {
  const recurse = (node: SceneNode, parent: ContainerNode | null) => {
    visit(node, parent);
    if (isContainer(node)) for (const child of node.children) recurse(child, node);
  };
  for (const layer of doc.layers) recurse(layer, null);
}

export function findNode(doc: VectarDocument, id: NodeId): NodeLocation | null {
  let found: NodeLocation | null = null;
  const recurse = (nodes: SceneNode[], parent: ContainerNode | null, ancestors: ContainerNode[]): boolean => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.id === id) {
        found = { node, parent, index: i, ancestors };
        return true;
      }
      if (isContainer(node) && recurse(node.children, node, [...ancestors, node])) return true;
    }
    return false;
  };
  recurse(doc.layers, null, []);
  return found;
}

export function findNodes(doc: VectarDocument, ids: readonly NodeId[]): SceneNode[] {
  const wanted = new Set(ids);
  const result: SceneNode[] = [];
  walk(doc, (node) => {
    if (wanted.has(node.id)) result.push(node);
  });
  return result;
}

/** The layer a node belongs to, or null if the id is unknown. */
export function owningLayer(doc: VectarDocument, id: NodeId): SceneNode | null {
  const location = findNode(doc, id);
  if (!location) return null;
  return location.ancestors[0] ?? location.node;
}

/** Transform from a node's local space to document space. */
export function worldTransform(doc: VectarDocument, id: NodeId): Matrix {
  const location = findNode(doc, id);
  if (!location) return identity();
  return compose(...location.ancestors.map((a) => a.transform), location.node.transform);
}

/** Transform from a node's parent space to document space. */
export function parentTransform(doc: VectarDocument, id: NodeId): Matrix {
  const location = findNode(doc, id);
  if (!location) return identity();
  return compose(...location.ancestors.map((a) => a.transform));
}

/** Effective opacity, including every ancestor's. */
export function worldOpacity(doc: VectarDocument, id: NodeId): number {
  const location = findNode(doc, id);
  if (!location) return 1;
  return [...location.ancestors, location.node].reduce((acc, n) => acc * n.opacity, 1);
}

/** True when the node and all its ancestors are visible. */
export function isEffectivelyVisible(doc: VectarDocument, id: NodeId): boolean {
  const location = findNode(doc, id);
  if (!location) return false;
  return [...location.ancestors, location.node].every((n) => n.visible);
}

/** True when the node or any ancestor is locked. */
export function isEffectivelyLocked(doc: VectarDocument, id: NodeId): boolean {
  const location = findNode(doc, id);
  if (!location) return false;
  return [...location.ancestors, location.node].some((n) => n.locked);
}

/** Bounds in the node's own local coordinates, ignoring its own transform. */
export function localBounds(node: SceneNode, measure: TextMeasurer = estimateTextBounds): Rect | null {
  switch (node.type) {
    case 'path': {
      const geometry = P.bounds(node.path);
      if (!geometry) return null;
      if (!isStrokeVisible(node.stroke)) return geometry;
      return R.inflate(geometry, node.stroke.width / 2);
    }
    case 'text':
      return measure(node);
    case 'image':
      return { x: node.x, y: node.y, width: node.width, height: node.height };
    case 'group':
    case 'layer': {
      const rects = node.children.map((child) => {
        const b = localBounds(child, measure);
        return b ? R.transform(b, child.transform) : null;
      });
      return R.unionAll(rects);
    }
  }
}

/** Bounds in document space, with `node.transform` and `parent` applied. */
export function worldBounds(
  node: SceneNode,
  parent: Matrix = identity(),
  measure: TextMeasurer = estimateTextBounds,
): Rect | null {
  const local = localBounds(node, measure);
  if (!local) return null;
  return R.transform(local, compose(parent, node.transform));
}

/** Union of the world bounds of several nodes, looked up by id. */
export function selectionBounds(
  doc: VectarDocument,
  ids: readonly NodeId[],
  measure: TextMeasurer = estimateTextBounds,
): Rect | null {
  const rects = ids.map((id) => {
    const location = findNode(doc, id);
    if (!location) return null;
    return worldBounds(location.node, parentTransform(doc, id), measure);
  });
  return R.unionAll(rects);
}

/** Options controlling which nodes hit tests may return. */
export type HitOptions = {
  /** Extra tolerance in document units, usually a few screen pixels. */
  tolerance?: number;
  /** Include nodes inside groups instead of stopping at the group. */
  deep?: boolean;
  measure?: TextMeasurer;
};

function hitNode(
  node: SceneNode,
  point: Vec,
  parent: Matrix,
  options: Required<HitOptions>,
): SceneNode | null {
  if (!node.visible || node.locked) return null;
  const world = compose(parent, node.transform);

  if (isContainer(node)) {
    // Children are drawn in order, so the last match is the topmost one.
    for (let i = node.children.length - 1; i >= 0; i--) {
      const hit = hitNode(node.children[i], point, world, options);
      if (hit) return options.deep || node.type === 'layer' ? hit : node;
    }
    return null;
  }

  const inverse = invert(world);
  if (!inverse) return null;
  const local = applyToPoint(inverse, point);
  const scale = meanScale(world);
  const tolerance = options.tolerance / (scale || 1);

  if (node.type === 'path') {
    if (isFillVisible(node.fill) && P.containsPoint(node.path, local)) return node;
    if (isStrokeVisible(node.stroke)) {
      const reach = node.stroke.width / 2 + tolerance;
      if (P.isNearOutline(node.path, local, reach)) return node;
    }
    // An unfilled, unstroked path is still selectable near its outline.
    if (!isFillVisible(node.fill) && !isStrokeVisible(node.stroke)) {
      if (P.isNearOutline(node.path, local, tolerance)) return node;
    }
    return null;
  }

  const box = localBounds(node, options.measure);
  if (box && R.containsPoint(R.inflate(box, tolerance), local)) return node;
  return null;
}

/** Topmost node under `point`, in document coordinates. */
export function hitTest(doc: VectarDocument, point: Vec, options: HitOptions = {}): SceneNode | null {
  const resolved: Required<HitOptions> = {
    tolerance: options.tolerance ?? 3,
    deep: options.deep ?? false,
    measure: options.measure ?? estimateTextBounds,
  };
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const hit = hitNode(doc.layers[i], point, identity(), resolved);
    if (hit) return hit;
  }
  return null;
}

/**
 * Nodes whose world bounds fall inside `area`. With `strict` the bounds must
 * be fully contained; otherwise touching is enough.
 */
export function nodesInRect(
  doc: VectarDocument,
  area: Rect,
  options: { strict?: boolean; deep?: boolean; measure?: TextMeasurer } = {},
): SceneNode[] {
  const strict = options.strict ?? true;
  const deep = options.deep ?? false;
  const measure = options.measure ?? estimateTextBounds;
  const result: SceneNode[] = [];

  const recurse = (node: SceneNode, parent: Matrix): void => {
    if (!node.visible || node.locked) return;
    const world = compose(parent, node.transform);
    if (node.type === 'layer') {
      for (const child of node.children) recurse(child, world);
      return;
    }
    if (isContainer(node) && deep) {
      for (const child of node.children) recurse(child, world);
      return;
    }
    const box = localBounds(node, measure);
    if (!box) return;
    const worldBox = R.transform(box, world);
    if (strict ? R.contains(area, worldBox) : R.intersects(area, worldBox)) result.push(node);
  };

  for (const layer of doc.layers) recurse(layer, identity());
  return result;
}

/** Every node in the document, in draw order. */
export function allNodes(doc: VectarDocument): SceneNode[] {
  const result: SceneNode[] = [];
  walk(doc, (node) => result.push(node));
  return result;
}

/** Counts of each node type, for the status bar. */
export function documentStats(doc: VectarDocument): { nodes: number; paths: number; anchors: number } {
  let nodes = 0;
  let paths = 0;
  let anchors = 0;
  walk(doc, (node) => {
    nodes += 1;
    if (node.type === 'path') {
      paths += 1;
      for (const sp of node.path.subpaths) anchors += sp.anchors.length;
    }
  });
  return { nodes, paths, anchors };
}
