import { cloneNode, type SceneNode } from '../../core/model/node.ts';
import * as commands from '../../core/model/commands.ts';
import type { DocumentStore } from './document-store.ts';
import type { SelectionStore } from './selection-store.ts';
import type { StatusStore } from './status-store.ts';

/**
 * Cut, copy and paste.
 *
 * These straddle the document and the selection, so they live in their own
 * store that reads both rather than being bolted onto either one. Copied
 * nodes are detached clones, so editing the originals afterwards does not
 * change what will be pasted.
 */
export class Clipboard {
  private contents: SceneNode[] = [];
  private docs: DocumentStore;
  private selection: SelectionStore;
  private status: StatusStore;

  constructor(docs: DocumentStore, selection: SelectionStore, status: StatusStore) {
    this.docs = docs;
    this.selection = selection;
    this.status = status;
  }

  get isEmpty(): boolean {
    return this.contents.length === 0;
  }

  copy(): void {
    const nodes = this.selection.nodes();
    if (nodes.length === 0) return;
    this.contents = nodes.map((node) => cloneNode(node, false));
    this.status.set(`Copied ${nodes.length} object${nodes.length === 1 ? '' : 's'}`);
  }

  cut(): void {
    const nodes = this.selection.nodes();
    if (nodes.length === 0) return;
    this.copy();
    this.docs.transaction('Cut', () => {
      this.docs.run(commands.removeNodes(this.docs.document, nodes.map((n) => n.id)));
    });
    this.selection.clear();
  }

  /** Fresh copies of the clipboard contents, ready to be added. */
  take(): SceneNode[] {
    return this.contents.map((node) => cloneNode(node, true));
  }
}
