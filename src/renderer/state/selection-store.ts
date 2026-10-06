import type { Rect } from '../../core/geometry/rect.ts';
import {
  createLayerNode, isContainer,
  type ContainerNode, type LayerNode, type NodeId, type PathNode, type SceneNode,
} from '../../core/model/node.ts';
import * as query from '../../core/model/query.ts';
import type { EventBus } from '../events.ts';
import type { DocumentStore } from './document-store.ts';

/**
 * The anchors selected inside one path, for the anchor-editing tool.
 *
 * "Node" is the term the UI uses for an anchor, following other vector
 * editors, but in this codebase a node is a `SceneNode`. Everything below the
 * UI therefore says anchor.
 */
export type AnchorSelection = {
  nodeId: NodeId;
  /** `subpathIndex:anchorIndex` keys. */
  anchors: Set<string>;
};

export const anchorKey = (subpath: number, anchor: number): string => `${subpath}:${anchor}`;

export const parseAnchorKey = (key: string): { subpath: number; anchor: number } => {
  const [subpath, anchor] = key.split(':').map(Number);
  return { subpath, anchor };
};

/**
 * What is currently selected, and which layer new objects go into.
 *
 * Selection is only meaningful against a document, so this store reads from
 * `DocumentStore`; it never writes to it.
 */
export class SelectionStore {
  ids = new Set<NodeId>();
  anchors: AnchorSelection | null = null;
  activeLayerId: NodeId;

  private events: EventBus;
  private docs: DocumentStore;
  /** Measures text, injected so this store does not depend on the DOM. */
  private measure: query.TextMeasurer;

  constructor(events: EventBus, docs: DocumentStore, measure: query.TextMeasurer) {
    this.events = events;
    this.docs = docs;
    this.measure = measure;
    this.activeLayerId = docs.document.layers[0]?.id ?? '';
    // A new document invalidates everything selected in the old one.
    docs.observeReplace(() => {
      this.ids.clear();
      this.anchors = null;
      this.activeLayerId = this.docs.document.layers[0]?.id ?? '';
    });
  }

  get size(): number {
    return this.ids.size;
  }

  has(id: NodeId): boolean {
    return this.ids.has(id);
  }

  // --- changing the selection --------------------------------------------

  set(ids: Iterable<NodeId>): void {
    this.ids = new Set(ids);
    if (this.anchors && !this.ids.has(this.anchors.nodeId)) this.anchors = null;
    this.events.emit('selection');
  }

  add(id: NodeId): void {
    this.ids.add(id);
    this.events.emit('selection');
  }

  toggle(id: NodeId): void {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.events.emit('selection');
  }

  clear(): void {
    if (this.ids.size === 0 && !this.anchors) return;
    this.ids.clear();
    this.anchors = null;
    this.events.emit('selection');
  }

  selectAll(): void {
    const ids: NodeId[] = [];
    for (const layer of this.docs.document.layers) {
      if (!layer.visible || layer.locked) continue;
      for (const child of layer.children) {
        if (child.visible && !child.locked) ids.push(child.id);
      }
    }
    this.set(ids);
  }

  /** Drops ids that no longer exist, as after an undo. */
  prune(): void {
    for (const id of [...this.ids]) {
      if (!query.findNode(this.docs.document, id)) this.ids.delete(id);
    }
    if (this.anchors && !query.findNode(this.docs.document, this.anchors.nodeId)) {
      this.anchors = null;
    }
  }

  setAnchors(nodeId: NodeId, anchors: Set<string>): void {
    this.anchors = { nodeId, anchors };
    this.events.emit('selection');
  }

  clearAnchors(): void {
    if (!this.anchors) return;
    this.anchors = null;
    this.events.emit('selection');
  }

  // --- reading the selection ---------------------------------------------

  nodes(): SceneNode[] {
    return query.findNodes(this.docs.document, [...this.ids]);
  }

  bounds(): Rect | null {
    return query.selectionBounds(this.docs.document, [...this.ids], this.measure);
  }

  /** The single selected path, when exactly one path is selected. */
  singlePath(): PathNode | null {
    if (this.ids.size !== 1) return null;
    const node = this.nodes()[0];
    return node && node.type === 'path' ? node : null;
  }

  // --- layers -------------------------------------------------------------

  activeLayer(): LayerNode {
    const found = this.docs.document.layers.find((layer) => layer.id === this.activeLayerId);
    if (found) return found;
    const fallback = this.docs.document.layers[0] ?? createLayerNode('Layer 1');
    if (this.docs.document.layers.length === 0) this.docs.document.layers.push(fallback);
    this.activeLayerId = fallback.id;
    return fallback;
  }

  setActiveLayer(id: NodeId): void {
    this.activeLayerId = id;
    this.events.emit('selection');
  }

  /**
   * Where new objects go: the container the selection lives in, so drawing
   * inside a group stays inside it, otherwise the active layer.
   */
  insertionParent(): ContainerNode {
    if (this.ids.size === 1) {
      const location = query.findNode(this.docs.document, [...this.ids][0]);
      if (location?.parent && isContainer(location.parent) && !location.parent.locked) return location.parent;
    }
    return this.activeLayer();
  }
}
