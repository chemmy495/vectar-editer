import { clear, h } from '../dom.ts';
import { documentStats } from '../../core/model/query.ts';
import type { Editor } from '../editor.ts';

/** The bar along the bottom: zoom, counts, selection info and messages. */
export function createStatusBar(editor: Editor, container: HTMLElement): void {
  const render = () => {
    clear(container);
    const stats = documentStats(editor.document);
    const bounds = editor.selectionBounds();

    const selectionText =
      editor.selection.size === 0
        ? 'No selection'
        : editor.selection.size === 1 && bounds
          ? `1 object  ${Math.round(bounds.width)} x ${Math.round(bounds.height)}`
          : `${editor.selection.size} objects selected`;

    const items: Node[] = [
      h('span', { class: 'status-item', text: `Zoom ${Math.round(editor.viewport.scale * 100)}%` }),
      h('span', { class: 'status-item', text: `${stats.paths} paths` }),
      h('span', { class: 'status-item', text: `${stats.anchors} anchors` }),
      h('span', { class: 'status-item', text: selectionText }),
      h('span', { class: 'status-spacer' }),
    ];
    if (editor.snapToGrid) items.push(h('span', { class: 'status-item', text: 'Snap on' }));
    items.push(h('span', { class: 'status-message', text: editor.statusMessage }));
    container.append(...items);
  };

  for (const event of ['document', 'selection', 'view', 'status'] as const) editor.on(event, render);
  render();
}
