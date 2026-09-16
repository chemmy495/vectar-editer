import { identity, type Matrix } from '../core/geometry/matrix.ts';
import type { Rect } from '../core/geometry/rect.ts';
import { createDocument, documentPixelSize, type VectarDocument } from '../core/model/document.ts';
import { History, type Command } from '../core/model/history.ts';
import {
  cloneNode, createLayerNode, isContainer,
  type ContainerNode, type LayerNode, type NodeId, type SceneNode,
} from '../core/model/node.ts';
import * as ops from '../core/model/ops.ts';
import * as query from '../core/model/query.ts';
import { defaultFill, defaultStroke, noStroke, type Fill, type Stroke } from '../core/model/style.ts';
import { BLACK, type RGBA } from '../core/model/color.ts';
import { DEFAULT_BRUSH, type BrushOptions } from '../core/brush/stroke.ts';
import { Viewport } from './viewport.ts';

export type ToolId =
  | 'select' | 'node' | 'pen' | 'pencil' | 'brush'
  | 'rect' | 'ellipse' | 'polygon' | 'star' | 'line'
  | 'text' | 'eyedropper' | 'zoom' | 'pan';

export type EditorEvent =
  | 'document'   // geometry or structure changed
  | 'selection'
  | 'tool'
  | 'view'       // pan/zoom
  | 'style'      // the default fill/stroke for new objects
  | 'status';    // transient status message

/** A node reference plus the anchors selected inside it, for the node tool. */
export type NodeSelection = {
  nodeId: NodeId;
  /** `subpathIndex:anchorIndex` keys. */
  anchors: Set<string>;
};

export const anchorKey = (subpath: number, anchor: number): string => `${subpath}:${anchor}`;

export const parseAnchorKey = (key: string): { subpath: number; anchor: number } => {
  const [subpath, anchor] = key.split(':').map(Number);
  return { subpath, anchor };
};

export type ShapeDefaults = {
  cornerRadius: number;
  polygonSides: number;
  starPoints: number;
  starInnerRatio: number;
};

/**
 * Central editor state. Panels and tools read from it and subscribe to the
 * events they care about, so there is one source of truth for the document,
 * selection, history and tool settings.
 */
export class Editor {
  document: VectarDocument;
  history = new History(300);
  viewport = new Viewport();

  selection = new Set<NodeId>();
  nodeSelection: NodeSelection | null = null;
  activeLayerId: NodeId;

  tool: ToolId = 'select';
  /** Style applied to newly created objects. */
  fill: Fill = defaultFill(BLACK);
  stroke: Stroke = noStroke();
  brush: BrushOptions = { ...DEFAULT_BRUSH };
  shapeDefaults: ShapeDefaults = { cornerRadius: 0, polygonSides: 6, starPoints: 5, starInnerRatio: 0.5 };

  showGrid = false;
  snapToGrid = false;
  showRulers = true;
  gridSize = 20;

  /** Path of the file backing the document, when it has one. */
  filePath: string | null = null;
  dirty = false;
  statusMessage = '';

  /** Objects on the clipboard, already detached from the document. */
  clipboard: SceneNode[] = [];

  private listeners = new Map<EditorEvent, Set<() => void>>();
  /** History depth at the last save, used to track the dirty flag. */
  private savedDepth = 0;

  constructor(doc: VectarDocument = createDocument()) {
    this.document = doc;
    this.activeLayerId = doc.layers[0]?.id ?? '';
    this.history.onChange(() => {
      this.dirty = this.history.depth() !== this.savedDepth;
      this.emit('document');
    });
  }

  on(event: EditorEvent, listener: () => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit(...events: EditorEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
  }

  setStatus(message: string): void {
    this.statusMessage = message;
    this.emit('status');
  }

  // --- document lifecycle -------------------------------------------------

  /** Replaces the document, resetting history, selection and dirty state. */
  loadDocument(doc: VectarDocument, filePath: string | null): void {
    this.document = doc;
    this.filePath = filePath;
    this.activeLayerId = doc.layers[0]?.id ?? '';
    this.selection.clear();
    this.nodeSelection = null;
    this.history.clear();
    this.savedDepth = 0;
    this.dirty = false;
    this.emit('document', 'selection', 'view');
  }

  markSaved(filePath: string | null): void {
    if (filePath) this.filePath = filePath;
    this.savedDepth = this.history.depth();
    this.dirty = false;
    this.emit('document');
  }

  documentName(): string {
    return this.document.name || 'Untitled';
  }

  documentBounds(): Rect {
    const { width, height } = documentPixelSize(this.document);
    return { x: 0, y: 0, width, height };
  }

  // --- history ------------------------------------------------------------

  /** Runs a command and records it, ignoring nulls from failed operations. */
  run(command: Command | null): void {
    if (!command) return;
    this.history.execute(command);
  }

  /** Groups every command pushed inside `body` into a single undo step. */
  transaction<T>(label: string, body: () => T): T {
    return this.history.transaction(label, body);
  }

  undo(): void {
    if (this.history.undo()) {
      this.pruneSelection();
      this.emit('document', 'selection');
    }
  }

  redo(): void {
    if (this.history.redo()) {
      this.pruneSelection();
      this.emit('document', 'selection');
    }
  }

  // --- selection ----------------------------------------------------------

  setSelection(ids: Iterable<NodeId>): void {
    this.selection = new Set(ids);
    if (this.nodeSelection && !this.selection.has(this.nodeSelection.nodeId)) this.nodeSelection = null;
    this.emit('selection');
  }

  addToSelection(id: NodeId): void {
    this.selection.add(id);
    this.emit('selection');
  }

  toggleSelection(id: NodeId): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.emit('selection');
  }

  clearSelection(): void {
    if (this.selection.size === 0 && !this.nodeSelection) return;
    this.selection.clear();
    this.nodeSelection = null;
    this.emit('selection');
  }

  selectAll(): void {
    const ids: NodeId[] = [];
    for (const layer of this.document.layers) {
      if (!layer.visible || layer.locked) continue;
      for (const child of layer.children) {
        if (child.visible && !child.locked) ids.push(child.id);
      }
    }
    this.setSelection(ids);
  }

  /** Drops selected ids that no longer exist, e.g. after an undo. */
  pruneSelection(): void {
    for (const id of [...this.selection]) {
      if (!query.findNode(this.document, id)) this.selection.delete(id);
    }
    if (this.nodeSelection && !query.findNode(this.document, this.nodeSelection.nodeId)) {
      this.nodeSelection = null;
    }
  }

  selectedNodes(): SceneNode[] {
    return query.findNodes(this.document, [...this.selection]);
  }

  selectionBounds(): Rect | null {
    return query.selectionBounds(this.document, [...this.selection], this.measureText);
  }

  /** The single selected path node, when exactly one path is selected. */
  singleSelectedPath(): SceneNode | null {
    if (this.selection.size !== 1) return null;
    const node = this.selectedNodes()[0];
    return node && node.type === 'path' ? node : null;
  }

  // --- layers -------------------------------------------------------------

  activeLayer(): LayerNode {
    const found = this.document.layers.find((layer) => layer.id === this.activeLayerId);
    if (found) return found;
    const fallback = this.document.layers[0] ?? createLayerNode('Layer 1');
    if (this.document.layers.length === 0) this.document.layers.push(fallback);
    this.activeLayerId = fallback.id;
    return fallback;
  }

  setActiveLayer(id: NodeId): void {
    this.activeLayerId = id;
    this.emit('selection');
  }

  /**
   * Where new objects go: the active layer, or the container the current
   * selection lives in so drawing inside a group stays inside it.
   */
  insertionParent(): ContainerNode {
    if (this.selection.size === 1) {
      const location = query.findNode(this.document, [...this.selection][0]);
      if (location?.parent && isContainer(location.parent) && !location.parent.locked) return location.parent;
    }
    return this.activeLayer();
  }

  /** Adds nodes to the insertion parent and selects them. */
  addNodes(nodes: SceneNode[], label = 'Add object'): void {
    if (nodes.length === 0) return;
    const parent = this.insertionParent();
    this.transaction(label, () => {
      this.run(ops.addNodes(this.document, parent, nodes));
    });
    this.setSelection(nodes.map((n) => n.id));
  }

  // --- clipboard ----------------------------------------------------------

  copy(): void {
    const nodes = this.selectedNodes();
    if (nodes.length === 0) return;
    this.clipboard = nodes.map((node) => cloneNode(node, false));
    this.setStatus(`Copied ${nodes.length} object${nodes.length === 1 ? '' : 's'}`);
  }

  cut(): void {
    const nodes = this.selectedNodes();
    if (nodes.length === 0) return;
    this.copy();
    this.transaction('Cut', () => {
      this.run(ops.removeNodes(this.document, nodes.map((n) => n.id)));
    });
    this.clearSelection();
  }

  paste(): void {
    if (this.clipboard.length === 0) return;
    const copies = this.clipboard.map((node) => cloneNode(node, true));
    this.addNodes(copies, 'Paste');
  }

  duplicate(): void {
    const copies = ops.duplicateNodes(this.document, [...this.selection]);
    if (copies.length === 0) return;
    // Offset the copies slightly so they are visibly distinct.
    const offset: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 10 };
    for (const copy of copies) {
      copy.transform = { ...copy.transform, e: copy.transform.e + offset.e, f: copy.transform.f + offset.f };
    }
    this.addNodes(copies, 'Duplicate');
  }

  deleteSelection(): void {
    if (this.selection.size === 0) return;
    const ids = [...this.selection];
    this.transaction('Delete', () => {
      this.run(ops.removeNodes(this.document, ids));
    });
    this.clearSelection();
  }

  // --- text measurement ---------------------------------------------------

  /**
   * Real text metrics from a scratch canvas. Assigned as a property so it can
   * be passed straight to the query helpers.
   */
  measureText: query.TextMeasurer = (node) => {
    const context = Editor.measureContext();
    if (!context) return query.estimateTextBounds(node);
    const style = node.italic ? 'italic ' : '';
    context.font = `${style}${node.fontWeight} ${node.fontSize}px ${node.fontFamily}, sans-serif`;
    const lines = node.text.split('\n');
    let width = 0;
    for (const line of lines) {
      const measured = context.measureText(line).width + Math.max(0, line.length - 1) * node.letterSpacing;
      width = Math.max(width, measured);
    }
    const ascent = node.fontSize * 0.8;
    const height = (lines.length - 1) * node.fontSize * node.lineHeight + node.fontSize;
    const offsetX = node.align === 'middle' ? -width / 2 : node.align === 'end' ? -width : 0;
    return { x: node.x + offsetX, y: node.y - ascent, width, height };
  };

  private static sharedContext: CanvasRenderingContext2D | null | undefined;

  private static measureContext(): CanvasRenderingContext2D | null {
    if (Editor.sharedContext === undefined) {
      Editor.sharedContext = document.createElement('canvas').getContext('2d');
    }
    return Editor.sharedContext;
  }

  // --- misc ---------------------------------------------------------------

  setTool(tool: ToolId): void {
    if (this.tool === tool) return;
    this.tool = tool;
    if (tool !== 'node') this.nodeSelection = null;
    this.emit('tool', 'selection');
  }

  setFill(fill: Fill): void {
    this.fill = fill;
    this.emit('style');
  }

  setStroke(stroke: Stroke): void {
    this.stroke = stroke;
    this.emit('style');
  }

  /** Snaps a document point to the grid when snapping is on. */
  snap(point: { x: number; y: number }): { x: number; y: number } {
    if (!this.snapToGrid || this.gridSize <= 0) return point;
    return {
      x: Math.round(point.x / this.gridSize) * this.gridSize,
      y: Math.round(point.y / this.gridSize) * this.gridSize,
    };
  }

  /** Default stroke used when a tool needs a visible outline. */
  strokeOrDefault(color: RGBA = BLACK): Stroke {
    return this.stroke.paint.type === 'none' ? defaultStroke(color, 1) : this.stroke;
  }

  identityMatrix(): Matrix {
    return identity();
  }
}
