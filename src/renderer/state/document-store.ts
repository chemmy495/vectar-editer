import type { Rect } from '../../core/geometry/rect.ts';
import { createDocument, documentPixelSize, type VectarDocument } from '../../core/model/document.ts';
import { History, type Command } from '../../core/model/history.ts';
import type { EventBus } from '../events.ts';

/**
 * The document and its undo history.
 *
 * Commands are built elsewhere (`core/model/commands.ts`) and handed here to
 * be applied and recorded, so this store owns *when* the document changes
 * without knowing *how* any particular edit works.
 */
export class DocumentStore {
  document: VectarDocument;
  readonly history = new History(300);

  /** Path of the file backing the document, when it has one. */
  filePath: string | null = null;
  dirty = false;

  private events: EventBus;
  /**
   * The command on top of the undo stack when the document was last saved.
   * Compared by identity: stack depth cannot tell "undone then edited
   * differently" apart from "unchanged", and stops working once the stack
   * reaches its limit.
   */
  private savedCommand: Command | null = null;
  /** Notified after the document is replaced, so dependent state can reset. */
  private onReplace: Array<() => void> = [];

  constructor(events: EventBus, document: VectarDocument = createDocument()) {
    this.events = events;
    this.document = document;
    this.history.onChange(() => {
      this.refreshDirty();
      this.events.emit('document');
    });
  }

  observeReplace(listener: () => void): void {
    this.onReplace.push(listener);
  }

  // --- lifecycle ----------------------------------------------------------

  /** Replaces the document, resetting history and dirty state. */
  load(document: VectarDocument, filePath: string | null): void {
    this.document = document;
    this.filePath = filePath;
    this.history.clear();
    this.savedCommand = null;
    this.dirty = false;
    for (const listener of this.onReplace) listener();
    this.events.emit('document', 'selection', 'view');
  }

  markSaved(filePath: string | null): void {
    if (filePath) this.filePath = filePath;
    this.savedCommand = this.history.lastCommand();
    this.dirty = false;
    this.events.emit('document');
  }

  /** Marks a change that history does not record, such as a live preview. */
  markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.events.emit('document');
  }

  private refreshDirty(): void {
    this.dirty = this.history.lastCommand() !== this.savedCommand;
  }

  // --- editing ------------------------------------------------------------

  /** Applies a command and records it. Nulls from failed builders are ignored. */
  run(command: Command | null): void {
    if (!command) return;
    this.history.execute(command);
  }

  /** Groups every command applied inside `body` into one undo step. */
  transaction<T>(label: string, body: () => T): T {
    return this.history.transaction(label, body);
  }

  /** Records a command whose effect is already applied. */
  record(command: Command): void {
    this.history.push(command);
  }

  undo(): boolean {
    return this.history.undo();
  }

  redo(): boolean {
    return this.history.redo();
  }

  // --- queries ------------------------------------------------------------

  get name(): string {
    return this.document.name || 'Untitled';
  }

  /** The page rectangle, in document units. */
  get bounds(): Rect {
    const { width, height } = documentPixelSize(this.document);
    return { x: 0, y: 0, width, height };
  }
}
