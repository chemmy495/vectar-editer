import type { VectarDocument } from '../../core/model/document.ts';
import type { TextMeasurer } from '../../core/model/query.ts';
import { EventBus } from '../events.ts';
import { Clipboard } from './clipboard.ts';
import { DocumentStore } from './document-store.ts';
import { SelectionStore } from './selection-store.ts';
import { StatusStore } from './status-store.ts';
import { ToolSettings } from './tool-settings.ts';
import { ViewSettings } from './view-settings.ts';
import { createCanvasTextMeasurer } from './text-measure.ts';

/**
 * The editor's state, as a set of independent stores.
 *
 * This is a bag for dependency injection, not a facade: it has no behaviour
 * of its own, and each store can be built and tested on its own. Components
 * take the whole context and reach for the stores they need.
 */
export type EditorContext = {
  events: EventBus;
  docs: DocumentStore;
  selection: SelectionStore;
  tools: ToolSettings;
  view: ViewSettings;
  status: StatusStore;
  clipboard: Clipboard;
  /** Shared so bounds come out the same everywhere text is measured. */
  measureText: TextMeasurer;
};

export function createEditorContext(options: {
  document?: VectarDocument;
  measureText?: TextMeasurer;
} = {}): EditorContext {
  const events = new EventBus();
  const measureText = options.measureText ?? createCanvasTextMeasurer();

  const docs = new DocumentStore(events, options.document);
  const selection = new SelectionStore(events, docs, measureText);
  const status = new StatusStore(events);
  const tools = new ToolSettings(events);
  const view = new ViewSettings(events);
  const clipboard = new Clipboard(docs, selection, status);

  // Undo and redo can remove the objects that were selected.
  docs.history.onChange(() => {
    const before = selection.size;
    selection.prune();
    if (selection.size !== before) events.emit('selection');
  });
  // Leaving the anchor tool drops the anchors it had selected.
  tools.observeTool((tool) => {
    if (tool !== 'node') selection.clearAnchors();
  });

  return { events, docs, selection, tools, view, status, clipboard, measureText };
}
