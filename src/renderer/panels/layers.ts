import { button, clear, h } from '../dom.ts';
import * as ops from '../../core/model/ops.ts';
import * as query from '../../core/model/query.ts';
import { isContainer, type NodeId, type SceneNode } from '../../core/model/node.ts';
import type { Editor } from '../editor.ts';

const TYPE_LABEL: Record<SceneNode['type'], string> = {
  layer: 'Layer', group: 'Group', path: 'Path', text: 'Text', image: 'Image',
};

/**
 * The layer and object tree. Rows can be selected, renamed, reordered and
 * toggled for visibility and locking.
 */
export function createLayersPanel(editor: Editor, container: HTMLElement): void {
  /** Ids of containers the user has collapsed. */
  const collapsed = new Set<NodeId>();

  const toggleFlag = (node: SceneNode, key: 'visible' | 'locked') => {
    editor.transaction(key === 'visible' ? 'Toggle visibility' : 'Toggle lock', () => {
      editor.run(ops.patchNode(editor.document, node.id, { [key]: !node[key] } as Partial<SceneNode>, 'Toggle'));
    });
  };

  const startRename = (node: SceneNode, label: HTMLElement) => {
    const input = h('input', { class: 'layer-rename', value: node.name });
    label.replaceWith(input);
    input.focus();
    input.select();
    const commit = (save: boolean) => {
      if (save && input.value.trim() !== '' && input.value !== node.name) {
        editor.transaction('Rename', () => {
          editor.run(ops.patchNode(editor.document, node.id, { name: input.value.trim() }, 'Rename'));
        });
      } else {
        render();
      }
    };
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') commit(true);
      else if (event.key === 'Escape') commit(false);
    });
  };

  const renderRow = (node: SceneNode, depth: number, list: HTMLElement) => {
    const isLayer = node.type === 'layer';
    const selected = editor.selection.has(node.id) || (isLayer && editor.activeLayerId === node.id);
    const row = h('div', {
      class: `layer-row${selected ? ' selected' : ''}${isLayer ? ' layer' : ''}`,
      draggable: 'true',
      'data-id': node.id,
    });
    row.style.paddingLeft = `${6 + depth * 14}px`;

    if (isContainer(node) && node.children.length > 0) {
      const twisty = h('button', {
        class: 'layer-twisty',
        type: 'button',
        text: collapsed.has(node.id) ? '▸' : '▾',
        title: collapsed.has(node.id) ? 'Expand' : 'Collapse',
      });
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        if (collapsed.has(node.id)) collapsed.delete(node.id);
        else collapsed.add(node.id);
        render();
      });
      row.append(twisty);
    } else {
      row.append(h('span', { class: 'layer-twisty-spacer' }));
    }

    const visibility = h('button', {
      class: `layer-flag${node.visible ? '' : ' off'}`,
      type: 'button',
      title: node.visible ? 'Hide' : 'Show',
      text: node.visible ? '◉' : '○',
    });
    visibility.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFlag(node, 'visible');
    });

    const lock = h('button', {
      class: `layer-flag${node.locked ? ' on' : ''}`,
      type: 'button',
      title: node.locked ? 'Unlock' : 'Lock',
      text: node.locked ? '■' : '□',
    });
    lock.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFlag(node, 'locked');
    });

    const label = h('span', { class: 'layer-name', text: node.name, title: `${TYPE_LABEL[node.type]}: ${node.name}` });
    label.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      startRename(node, label);
    });

    row.append(visibility, lock, label, h('span', { class: 'layer-type', text: TYPE_LABEL[node.type] }));

    row.addEventListener('click', (event) => {
      if (isLayer) {
        editor.setActiveLayer(node.id);
        if (!event.shiftKey) editor.clearSelection();
        return;
      }
      const layer = query.owningLayer(editor.document, node.id);
      if (layer) editor.activeLayerId = layer.id;
      if (event.shiftKey || event.ctrlKey) editor.toggleSelection(node.id);
      else editor.setSelection([node.id]);
    });

    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', node.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('drop-target');
      const draggedId = event.dataTransfer?.getData('text/plain');
      if (!draggedId || draggedId === node.id) return;
      handleDrop(draggedId, node);
    });

    list.append(row);

    if (isContainer(node) && !collapsed.has(node.id)) {
      // Children are listed top-most first, matching what the canvas shows.
      for (let i = node.children.length - 1; i >= 0; i--) renderRow(node.children[i], depth + 1, list);
    }
  };

  /** Moves the dragged node onto or next to the drop target. */
  const handleDrop = (draggedId: NodeId, target: SceneNode) => {
    const dragged = query.findNode(editor.document, draggedId);
    if (!dragged) return;

    if (dragged.node.type === 'layer') {
      if (target.type !== 'layer') return;
      const toIndex = editor.document.layers.findIndex((layer) => layer.id === target.id);
      editor.transaction('Reorder layers', () => {
        editor.run(ops.moveLayer(editor.document, draggedId, toIndex));
      });
      return;
    }

    if (isContainer(target)) {
      editor.transaction('Move to layer', () => {
        editor.run(ops.reparentNodes(editor.document, [draggedId], target));
      });
      return;
    }

    const targetLocation = query.findNode(editor.document, target.id);
    if (!targetLocation?.parent) return;
    editor.transaction('Reorder', () => {
      editor.run(ops.reparentNodes(editor.document, [draggedId], targetLocation.parent!, targetLocation.index + 1));
    });
  };

  const render = () => {
    clear(container);

    const header = h('div', { class: 'panel-header' }, [
      h('span', { text: 'Layers' }),
      button('+', () => {
        const added = ops.addLayer(editor.document);
        editor.transaction('Add layer', () => editor.run(added.command));
        editor.setActiveLayer(added.layer.id);
      }, { class: 'icon-button', title: 'Add layer' }),
      button('−', () => {
        const command = ops.removeLayer(editor.document, editor.activeLayerId);
        if (!command) {
          editor.setStatus('A document needs at least one layer');
          return;
        }
        editor.transaction('Delete layer', () => editor.run(command));
        editor.setActiveLayer(editor.document.layers[0]?.id ?? '');
      }, { class: 'icon-button', title: 'Delete active layer' }),
    ]);

    const list = h('div', { class: 'layer-list' });
    // Top layer first, so the list reads the same way the canvas stacks.
    for (let i = editor.document.layers.length - 1; i >= 0; i--) {
      renderRow(editor.document.layers[i], 0, list);
    }

    container.append(header, list);
  };

  for (const event of ['document', 'selection'] as const) editor.on(event, render);
  render();
}
