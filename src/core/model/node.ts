import { identity, type Matrix } from '../geometry/matrix.ts';
import { clonePath, emptyPath, type PathData } from '../path/path.ts';
import { cloneFill, cloneStroke, defaultFill, noFill, noStroke, type BlendMode, type Fill, type Stroke } from './style.ts';

export type NodeId = string;

let counter = 0;

/** Generates an id that is unique within the process. */
export function newId(prefix = 'n'): NodeId {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Resets the id counter. Only used to make test output deterministic. */
export function resetIdCounter(): void {
  counter = 0;
}

type NodeBase = {
  id: NodeId;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;
  /** Maps this node's local coordinates into its parent's coordinates. */
  transform: Matrix;
};

export type PathNode = NodeBase & {
  type: 'path';
  path: PathData;
  fill: Fill;
  stroke: Stroke;
};

export type GroupNode = NodeBase & {
  type: 'group';
  children: SceneNode[];
};

export type LayerNode = NodeBase & {
  type: 'layer';
  children: SceneNode[];
};

export type TextAlign = 'start' | 'middle' | 'end';

export type TextNode = NodeBase & {
  type: 'text';
  text: string;
  /** Baseline origin of the first line, in local coordinates. */
  x: number;
  y: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
  lineHeight: number;
  align: TextAlign;
  fill: Fill;
  stroke: Stroke;
};

export type ImageNode = NodeBase & {
  type: 'image';
  /** A `data:` URL holding the original raster bytes. */
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SceneNode = PathNode | GroupNode | LayerNode | TextNode | ImageNode;

export type ContainerNode = GroupNode | LayerNode;

export const isContainer = (node: SceneNode): node is ContainerNode =>
  node.type === 'group' || node.type === 'layer';

/** True for nodes that carry fill and stroke styling. */
export const isShape = (node: SceneNode): node is PathNode | TextNode =>
  node.type === 'path' || node.type === 'text';

function baseNode(name: string): NodeBase {
  return {
    id: newId(),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: identity(),
  };
}

export function createPathNode(path: PathData = emptyPath(), name = 'Path'): PathNode {
  return { ...baseNode(name), type: 'path', path, fill: defaultFill(), stroke: noStroke() };
}

export function createGroupNode(children: SceneNode[] = [], name = 'Group'): GroupNode {
  return { ...baseNode(name), type: 'group', children };
}

export function createLayerNode(name = 'Layer', children: SceneNode[] = []): LayerNode {
  return { ...baseNode(name), type: 'layer', children };
}

export function createTextNode(text = 'Text', x = 0, y = 0, name = 'Text'): TextNode {
  return {
    ...baseNode(name),
    type: 'text',
    text,
    x,
    y,
    fontFamily: 'Segoe UI',
    fontSize: 24,
    fontWeight: 400,
    italic: false,
    letterSpacing: 0,
    lineHeight: 1.2,
    align: 'start',
    fill: defaultFill(),
    stroke: noStroke(),
  };
}

export function createImageNode(href: string, width: number, height: number, name = 'Image'): ImageNode {
  return { ...baseNode(name), type: 'image', href, x: 0, y: 0, width, height };
}

/** Deep copy. `withNewIds` is what paste and duplicate need. */
export function cloneNode(node: SceneNode, withNewIds = false): SceneNode {
  const base = {
    id: withNewIds ? newId() : node.id,
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    blendMode: node.blendMode,
    transform: { ...node.transform },
  };
  switch (node.type) {
    case 'path':
      return { ...base, type: 'path', path: clonePath(node.path), fill: cloneFill(node.fill), stroke: cloneStroke(node.stroke) };
    case 'group':
      return { ...base, type: 'group', children: node.children.map((c) => cloneNode(c, withNewIds)) };
    case 'layer':
      return { ...base, type: 'layer', children: node.children.map((c) => cloneNode(c, withNewIds)) };
    case 'text':
      return {
        ...base,
        type: 'text',
        text: node.text,
        x: node.x,
        y: node.y,
        fontFamily: node.fontFamily,
        fontSize: node.fontSize,
        fontWeight: node.fontWeight,
        italic: node.italic,
        letterSpacing: node.letterSpacing,
        lineHeight: node.lineHeight,
        align: node.align,
        fill: cloneFill(node.fill),
        stroke: cloneStroke(node.stroke),
      };
    case 'image':
      return { ...base, type: 'image', href: node.href, x: node.x, y: node.y, width: node.width, height: node.height };
  }
}

/** A path node styled as a brush stroke: filled outline, no stroke. */
export function createBrushNode(path: PathData, fill: Fill, name = 'Brush'): PathNode {
  const node = createPathNode(path, name);
  node.fill = cloneFill(fill);
  node.stroke = noStroke();
  return node;
}

/** A path node styled as a drawn line: stroked, unfilled. */
export function createStrokeNode(path: PathData, stroke: Stroke, name = 'Stroke'): PathNode {
  const node = createPathNode(path, name);
  node.fill = noFill();
  node.stroke = cloneStroke(stroke);
  return node;
}
