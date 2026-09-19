import { h, clear } from '../dom.ts';
import type { Editor, ToolId } from '../editor.ts';

type ToolButton = { id: ToolId; label: string; icon: string; shortcut: string };

/** SVG path data for each tool glyph, drawn in a 24x24 box. */
const TOOL_BUTTONS: ToolButton[] = [
  { id: 'select', label: 'Select', shortcut: 'V', icon: 'M5 3l14 8-6 1.5L10 19z' },
  { id: 'node', label: 'Edit nodes', shortcut: 'A', icon: 'M4 18c6 0 10-12 16-12M2 16h4v4H2zM18 4h4v4h-4z' },
  { id: 'pen', label: 'Pen', shortcut: 'P', icon: 'M4 20l3-1 11-11-2-2L5 17zM16 4l4 4' },
  { id: 'pencil', label: 'Pencil', shortcut: 'N', icon: 'M3 21c4-1 6-3 8-7s4-8 8-10c-1 5-3 9-6 12s-6 5-10 5z' },
  { id: 'brush', label: 'Brush', shortcut: 'B', icon: 'M6 20c3 0 5-2 5-5 0-2-1-3-3-3s-4 2-4 5c0 2 1 3 2 3zM11 13l9-9 1 1-9 9' },
  { id: 'rect', label: 'Rectangle', shortcut: 'R', icon: 'M3 5h18v14H3z' },
  { id: 'ellipse', label: 'Ellipse', shortcut: 'E', icon: 'M12 5a9 7 0 100 14 9 7 0 100-14' },
  { id: 'polygon', label: 'Polygon', shortcut: '', icon: 'M12 3l9 6.5-3.5 10.5h-11L3 9.5z' },
  { id: 'star', label: 'Star', shortcut: '', icon: 'M12 3l2.6 6.2 6.4.5-4.9 4.2 1.5 6.1L12 16.8 6.4 20l1.5-6.1L3 9.7l6.4-.5z' },
  { id: 'line', label: 'Line', shortcut: 'L', icon: 'M4 20L20 4' },
  { id: 'text', label: 'Text', shortcut: 'T', icon: 'M5 5h14M12 5v14M9 19h6' },
  { id: 'eyedropper', label: 'Eyedropper', shortcut: 'I', icon: 'M15 3l6 6-3 3-1-1-7 7-4 1 1-4 7-7-1-1z' },
  { id: 'zoom', label: 'Zoom', shortcut: 'Z', icon: 'M11 4a7 7 0 100 14 7 7 0 100-14M16 16l5 5' },
];

/** The vertical tool strip down the left edge. */
export function createToolbar(editor: Editor, container: HTMLElement): void {
  const render = () => {
    clear(container);
    for (const tool of TOOL_BUTTONS) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', tool.icon);
      svg.append(path);

      const button = h('button', {
        class: `tool-button${editor.tool === tool.id ? ' active' : ''}`,
        title: tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label,
        type: 'button',
        'aria-pressed': editor.tool === tool.id ? 'true' : 'false',
      }, [svg]);
      button.addEventListener('click', () => editor.setTool(tool.id));
      container.append(button);
    }
  };

  editor.on('tool', render);
  render();
}
