/**
 * A single reversible edit. Commands store only the data needed to undo
 * themselves, which keeps history cheap even for documents with thousands of
 * traced paths.
 */
export type Command = {
  label: string;
  redo: () => void;
  undo: () => void;
};

/** Bundles several commands so they undo and redo as one step. */
export function combineCommands(label: string, commands: readonly Command[]): Command {
  const list = commands.slice();
  return {
    label,
    redo: () => {
      for (const c of list) c.redo();
    },
    undo: () => {
      for (let i = list.length - 1; i >= 0; i--) list[i].undo();
    },
  };
}

export type HistoryListener = (history: History) => void;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private limit: number;
  private listeners: HistoryListener[] = [];
  /** Commands collected by the current `transaction`, if one is open. */
  private pending: Command[] | null = null;
  private pendingLabel = '';

  constructor(limit = 200) {
    this.limit = limit;
  }

  /** Runs a command's `redo` and records it. */
  execute(command: Command): void {
    command.redo();
    this.push(command);
  }

  /** Records a command whose effect has already been applied. */
  push(command: Command): void {
    if (this.pending) {
      this.pending.push(command);
      return;
    }
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.notify();
  }

  /**
   * Collects everything pushed inside `body` into one undo step. Nested
   * transactions join the outer one. If `body` throws, the collected commands
   * are rolled back.
   */
  transaction<T>(label: string, body: () => T): T {
    if (this.pending) return body();
    this.pending = [];
    this.pendingLabel = label;
    let result: T;
    try {
      result = body();
    } catch (error) {
      const collected = this.pending;
      this.pending = null;
      for (let i = collected.length - 1; i >= 0; i--) collected[i].undo();
      throw error;
    }
    const collected = this.pending;
    this.pending = null;
    if (collected.length === 1) this.push(collected[0]);
    else if (collected.length > 1) this.push(combineCommands(this.pendingLabel, collected));
    return result;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undoLabel(): string | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  redoLabel(): string | null {
    return this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo();
    this.redoStack.push(command);
    this.notify();
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.redo();
    this.undoStack.push(command);
    this.notify();
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  /** Number of recorded undo steps, exposed for tests and the status bar. */
  depth(): number {
    return this.undoStack.length;
  }

  /**
   * The command on top of the undo stack, or null when nothing is recorded.
   * Callers compare it by identity to tell whether the document has moved
   * away from a known state, which stack depth alone cannot express.
   */
  lastCommand(): Command | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : null;
  }

  onChange(listener: HistoryListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this);
  }
}
