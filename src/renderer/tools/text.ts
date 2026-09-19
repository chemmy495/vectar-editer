import { createTextNode, type TextNode } from '../../core/model/node.ts';
import { cloneFill, cloneStroke } from '../../core/model/style.ts';
import * as ops from '../../core/model/ops.ts';
import * as query from '../../core/model/query.ts';
import type { Editor } from '../editor.ts';
import type { CanvasView } from '../canvas.ts';
import type { Tool } from '../tool.ts';

/**
 * Click to place a text object, or click existing text to edit it. Editing
 * uses a transparent textarea positioned over the canvas, so IME input works.
 */
export function createTextTool(editor: Editor, canvas: CanvasView): Tool {
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
        const command = ops.removeNodes(editor.document, [node.id]);
        command.redo();
        editor.clearSelection();
      }
      editor.emit('document');
      return;
    }

    node.text = original;
    if (isNew) {
      node.text = value;
      editor.addNodes([node], 'Add text');
    } else if (value !== original) {
      editor.transaction('Edit text', () => {
        editor.run(ops.patchNode<TextNode>(editor.document, node.id, { text: value }, 'Edit text'));
      });
    }
    editor.emit('document');
  };

  /** Places a textarea over the node so typing shows in context. */
  const openEditor = (node: TextNode, isNew: boolean) => {
    closeEditor(true);
    const input = document.createElement('textarea');
    input.className = 'text-editor';
    input.value = node.text;
    input.spellcheck = false;

    const world = query.worldTransform(editor.document, node.id);
    const screen = editor.viewport.toScreen({
      x: world.a * node.x + world.c * node.y + world.e,
      y: world.b * node.x + world.d * node.y + world.f,
    });
    const scale = editor.viewport.scale * Math.hypot(world.a, world.b);
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
      editor.emit('document');
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
      const hit = query.hitTest(editor.document, point, {
        tolerance: editor.viewport.toDocumentLength(4),
        deep: true,
        measure: editor.measureText,
      });
      if (hit && hit.type === 'text') {
        editor.setSelection([hit.id]);
        openEditor(hit, false);
        return;
      }

      const snapped = editor.snap(point);
      const node = createTextNode('', snapped.x, snapped.y, 'Text');
      node.fill = cloneFill(editor.fill);
      node.stroke = cloneStroke(editor.stroke);
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
