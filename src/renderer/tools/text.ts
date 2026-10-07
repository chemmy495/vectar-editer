import { createTextNode, type TextNode } from '../../core/model/node.ts';
import { cloneFill, cloneStroke } from '../../core/model/style.ts';
import * as commands from '../../core/model/commands.ts';
import * as query from '../../core/model/query.ts';

import type { CanvasView } from '../canvas.ts';
import type { Tool } from '../tool.ts';
import type { EditorContext } from '../state/context.ts';
import { addNodes } from '../editing.ts';

/**
 * Click to place a text object, or click existing text to edit it. Editing
 * uses a transparent textarea positioned over the canvas, so IME input works.
 */
export function createTextTool(editor: EditorContext, canvas: CanvasView): Tool {
  let editing: { node: TextNode; input: HTMLTextAreaElement; original: string; isNew: boolean } | null = null;

  const closeEditor = (commit: boolean) => {
    if (!editing) return;
    const { node, input, original, isNew } = editing;
    editing = null;
    const value = input.value;
    input.remove();

    if (!commit || value.trim() === '') {
      node.text = original;
      if (isNew) {
        // A cancelled new object should leave nothing behind.
        const command = commands.removeNodes(editor.docs.document, [node.id]);
        command.redo();
        editor.selection.clear();
      }
      editor.events.emit('document');
      return;
    }

    node.text = original;
    if (isNew) {
      node.text = value;
      addNodes(editor, [node], 'Add text');
    } else if (value !== original) {
      editor.docs.transaction('Edit text', () => {
        editor.docs.run(commands.patchNode<TextNode>(editor.docs.document, node.id, { text: value }, 'Edit text'));
      });
    }
    editor.events.emit('document');
  };

  /** Places a textarea over the node so typing shows in context. */
  const openEditor = (node: TextNode, isNew: boolean) => {
    closeEditor(true);
    const input = document.createElement('textarea');
    input.className = 'text-editor';
    input.value = node.text;
    input.spellcheck = false;

    const world = query.worldTransform(editor.docs.document, node.id);
    const screen = editor.view.viewport.toScreen({
      x: world.a * node.x + world.c * node.y + world.e,
      y: world.b * node.x + world.d * node.y + world.f,
    });
    const scale = editor.view.viewport.scale * Math.hypot(world.a, world.b);
    input.style.left = `${screen.x}px`;
    input.style.top = `${screen.y - node.fontSize * scale * 0.85}px`;
    input.style.fontSize = `${Math.max(8, node.fontSize * scale)}px`;
    input.style.fontFamily = node.fontFamily;
    input.style.fontWeight = String(node.fontWeight);
    input.style.fontStyle = node.italic ? 'italic' : 'normal';
    input.style.lineHeight = String(node.lineHeight);

    canvas.element.parentElement?.append(input);
    editing = { node, input, original: node.text, isNew };

    // Hide the underlying node so the textarea is the only visible copy.
    if (!isNew) {
      node.visible = false;
      editor.events.emit('document');
    }

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        if (editing && !editing.isNew) editing.node.visible = true;
        closeEditor(false);
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (editing && !editing.isNew) editing.node.visible = true;
        closeEditor(true);
      }
    });
    input.addEventListener('blur', () => {
      if (editing && !editing.isNew) editing.node.visible = true;
      closeEditor(true);
    });

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };

  return {
    id: 'text',
    cursor: 'text',

    onPointerDown(event, point) {
      if (event.button !== 0) return;
      const hit = query.hitTest(editor.docs.document, point, {
        tolerance: editor.view.viewport.toDocumentLength(4),
        deep: true,
        measure: editor.measureText,
      });
      if (hit && hit.type === 'text') {
        editor.selection.set([hit.id]);
        openEditor(hit, false);
        return;
      }

      const snapped = editor.view.snap(point);
      const node = createTextNode('', snapped.x, snapped.y, 'Text');
      node.fill = cloneFill(editor.tools.fill);
      node.stroke = cloneStroke(editor.tools.stroke);
      openEditor(node, true);
    },

    onKeyDown(event) {
      if (event.key !== 'Escape' || !editing) return false;
      closeEditor(false);
      return true;
    },

    deactivate() {
      closeEditor(true);
    },
  };
}
