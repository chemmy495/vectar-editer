import { clear, h } from '../dom.ts';
import { documentStats } from '../../core/model/query.ts';

import { Subscriptions, type Component } from '../lifecycle.ts';
import type { EditorContext } from '../state/context.ts';

/** The bar along the bottom: zoom, counts, selection info and messages. */
export function createStatusBar(editor: EditorContext, container: HTMLElement): Component {
  const render = () => {
    clear(container);
    const stats = documentStats(editor.docs.document);
    const bounds = editor.selection.bounds();

    const selectionText =
      editor.selection.ids.size === 0
        ? 'No selection'
        : editor.selection.ids.size === 1 && bounds
          ? `1 object  ${Math.round(bounds.width)} x ${Math.round(bounds.height)}`
          : `${editor.selection.ids.size} objects selected`;

    const items: Node[] = [
      h('span', { class: 'status-item', text: `Zoom ${Math.round(editor.view.viewport.scale * 100)}%` }),
      h('span', { class: 'status-item', text: `${stats.paths} paths` }),
      h('span', { class: 'status-item', text: `${stats.anchors} anchors` }),
      h('span', { class: 'status-item', text: selectionText }),
      h('span', { class: 'status-spacer' }),
    ];
    if (editor.view.snapToGrid) items.push(h('span', { class: 'status-item', text: 'Snap on' }));
    items.push(h('span', { class: 'status-message', text: editor.status.message }));
    container.append(...items);
  };

  const subscriptions = new Subscriptions();
  editor.events.bind(subscriptions, ['document', 'selection', 'view', 'status'], render);
  render();
  return { dispose: () => subscriptions.dispose() };
}
