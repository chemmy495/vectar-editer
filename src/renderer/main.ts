import { byId, h } from './dom.ts';
import { showDialog, showMessage } from './dialog.ts';
import { Editor, type ToolId } from './editor.ts';
import { CanvasView } from './canvas.ts';
import { createFileOperations } from './files.ts';
import { createToolbar } from './panels/toolbar.ts';
import { createLayersPanel } from './panels/layers.ts';
import { createPropertiesPanel } from './panels/properties.ts';
import { createStatusBar } from './panels/statusbar.ts';
import { createSelectTool } from './tools/select.ts';
import { createNodeTool } from './tools/node.ts';
import { createPenTool } from './tools/pen.ts';
import { createFreehandTool } from './tools/freehand.ts';
import { createShapeTool } from './tools/shape.ts';
import { createTextTool } from './tools/text.ts';
import { createEyedropperTool, createPanTool, createZoomTool } from './tools/utility.ts';
import {
  clearFlagEverywhere, convertSelectionToPaths, groupSelection, reorderSelection,
  reverseSelectedPaths, setSelectionFlag, simplifySelectedPaths, ungroupSelection,
} from './commands.ts';
import * as ops from '../core/model/ops.ts';
import type { MenuCommand } from '../main/ipc.ts';

const SHORTCUTS: Array<[string, string]> = [
  ['V / A', 'Select / Edit nodes'],
  ['P / N / B', 'Pen / Pencil / Brush'],
  ['R / E / L / T', 'Rectangle / Ellipse / Line / Text'],
  ['I / Z', 'Eyedropper / Zoom'],
  ['Space + drag', 'Pan the view'],
  ['Middle drag', 'Pan the view'],
  ['Wheel', 'Scroll; Ctrl+Wheel or Alt+Wheel to zoom'],
  ['Ctrl+0 / Ctrl+1', 'Fit to window / Actual size'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
  ['Ctrl+G / Ctrl+Shift+G', 'Group / Ungroup'],
  ['Ctrl+D', 'Duplicate'],
  ['Ctrl+Shift+I', 'Import an image and vectorize it'],
  ['Ctrl+E', 'Export'],
  ['Shift while dragging', 'Constrain to axis, angle or aspect'],
  ['Alt while dragging', 'Draw shapes from the centre'],
  ['Delete', 'Delete selection, or selected anchors'],
  ['Escape', 'Cancel the current action or deselect'],
];

function main(): void {
  const editor = new Editor();
  const canvas = new CanvasView(editor, byId('viewport'));
  const files = createFileOperations(editor, canvas);

  // --- tools -------------------------------------------------------------
  canvas.registerTool(createSelectTool(editor, canvas));
  canvas.registerTool(createNodeTool(editor, canvas));
  canvas.registerTool(createPenTool(editor, canvas));
  canvas.registerTool(createFreehandTool(editor, canvas, 'pencil'));
  canvas.registerTool(createFreehandTool(editor, canvas, 'brush'));
  for (const kind of ['rect', 'ellipse', 'polygon', 'star', 'line'] as const) {
    canvas.registerTool(createShapeTool(editor, canvas, kind));
  }
  canvas.registerTool(createTextTool(editor, canvas));
  canvas.registerTool(createEyedropperTool(editor));
  canvas.registerTool(createZoomTool(editor, canvas));
  canvas.registerTool(createPanTool(editor, canvas));

  editor.on('tool', () => canvas.setActiveTool(editor.tool));
  canvas.setActiveTool(editor.tool);

  // --- panels ------------------------------------------------------------
  createToolbar(editor, byId('toolbar'));
  createPropertiesPanel(editor, byId('properties'));
  createLayersPanel(editor, byId('layers'));
  createStatusBar(editor, byId('statusbar'));

  // --- window title ------------------------------------------------------
  const updateTitle = () => window.vectar.setTitle(editor.documentName(), editor.dirty);
  editor.on('document', updateTitle);
  updateTitle();

  const showShortcuts = () =>
    showDialog<void>('Keyboard Shortcuts', (close) => {
      const table = h('table', { class: 'shortcut-table' });
      for (const [keys, description] of SHORTCUTS) {
        table.append(h('tr', {}, [h('td', { text: keys }), h('td', { text: description })]));
      }
      return h('div', { class: 'modal-body' }, [
        table,
        h('div', { class: 'modal-actions' }, [
          h('button', { class: 'button primary', text: 'Close', onclick: () => close(null) }),
        ]),
      ]);
    }, { width: 480 });

  // --- command dispatch --------------------------------------------------
  const TOOL_COMMANDS: Record<string, ToolId> = {
    'tool.select': 'select', 'tool.node': 'node', 'tool.pen': 'pen', 'tool.pencil': 'pencil',
    'tool.brush': 'brush', 'tool.rect': 'rect', 'tool.ellipse': 'ellipse', 'tool.polygon': 'polygon',
    'tool.star': 'star', 'tool.line': 'line', 'tool.text': 'text', 'tool.eyedropper': 'eyedropper',
    'tool.zoom': 'zoom', 'tool.pan': 'pan',
  };

  const runCommand = (command: MenuCommand | string): void => {
    const tool = TOOL_COMMANDS[command];
    if (tool) {
      editor.setTool(tool);
      return;
    }

    switch (command) {
      case 'file.new': void files.newDocument(); break;
      case 'file.open': void files.openFile(); break;
      case 'file.save': void files.saveDocument(false); break;
      case 'file.saveAs': void files.saveDocument(true); break;
      case 'file.importImage': void files.importImage(); break;
      case 'file.importSvg': void files.importSvgFile(); break;
      case 'file.export': void files.exportDocument(); break;

      case 'edit.undo': editor.undo(); break;
      case 'edit.redo': editor.redo(); break;
      case 'edit.cut': editor.cut(); break;
      case 'edit.copy': editor.copy(); break;
      case 'edit.paste': editor.paste(); break;
      case 'edit.duplicate': editor.duplicate(); break;
      case 'edit.delete': editor.deleteSelection(); break;
      case 'edit.selectAll': editor.selectAll(); break;
      case 'edit.deselect': editor.clearSelection(); break;

      case 'view.zoomIn': editor.viewport.zoomAt({ x: editor.viewport.width / 2, y: editor.viewport.height / 2 }, 1.25); editor.emit('view'); break;
      case 'view.zoomOut': editor.viewport.zoomAt({ x: editor.viewport.width / 2, y: editor.viewport.height / 2 }, 1 / 1.25); editor.emit('view'); break;
      case 'view.zoomFit': canvas.zoomFit(); break;
      case 'view.zoomActual': editor.viewport.setZoom(1); editor.emit('view'); break;
      case 'view.toggleGrid': editor.showGrid = !editor.showGrid; editor.emit('view'); break;
      case 'view.toggleSnap': editor.snapToGrid = !editor.snapToGrid; editor.emit('view', 'status'); break;
      case 'view.toggleRulers': editor.showRulers = !editor.showRulers; editor.emit('view'); break;

      case 'object.group': groupSelection(editor); break;
      case 'object.ungroup': ungroupSelection(editor); break;
      case 'object.front': reorderSelection(editor, 'front'); break;
      case 'object.back': reorderSelection(editor, 'back'); break;
      case 'object.forward': reorderSelection(editor, 'forward'); break;
      case 'object.backward': reorderSelection(editor, 'backward'); break;
      case 'object.lock': setSelectionFlag(editor, 'locked', true); break;
      case 'object.unlockAll': clearFlagEverywhere(editor, 'locked', false); break;
      case 'object.hide': setSelectionFlag(editor, 'visible', false); break;
      case 'object.showAll': clearFlagEverywhere(editor, 'visible', true); break;

      case 'path.reverse': reverseSelectedPaths(editor); break;
      case 'path.simplify': simplifySelectedPaths(editor); break;
      case 'path.toPath': convertSelectionToPaths(editor); break;

      case 'layer.add': runLayerCommand('add'); break;
      case 'layer.delete': runLayerCommand('delete'); break;

      case 'help.shortcuts': void showShortcuts(); break;
      case 'help.about':
        void showMessage('Vectar Editor', [
          'A vector graphics editor: import an image, reproduce it as vector data, edit it freely, and export to many formats.',
          'Built with Electron and TypeScript.',
        ]);
        break;
      default:
        break;
    }
  };

  const runLayerCommand = (action: 'add' | 'delete') => {
    // The layers panel owns the buttons; the menu reuses the same operations.
    if (action === 'add') {
      const added = ops.addLayer(editor.document);
      editor.transaction('Add layer', () => editor.run(added.command));
      editor.setActiveLayer(added.layer.id);
    } else {
      const command = ops.removeLayer(editor.document, editor.activeLayerId);
      if (!command) {
        editor.setStatus('A document needs at least one layer');
        return;
      }
      editor.transaction('Delete layer', () => editor.run(command));
      editor.setActiveLayer(editor.document.layers[0]?.id ?? '');
    }
  };

  window.vectar.onMenuCommand(runCommand);

  // --- keyboard ----------------------------------------------------------
  const isTextEntry = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  window.addEventListener('keydown', (event) => {
    if (isTextEntry(event.target)) return;

    if (event.code === 'Space' && !event.repeat) {
      canvas.setSpaceHeld(true);
      event.preventDefault();
      return;
    }

    // The active tool gets first refusal on keys it handles itself.
    if (canvas.currentTool()?.onKeyDown?.(event)) return;

    const modifier = event.ctrlKey || event.metaKey;
    if (modifier) {
      // Accelerators that the Electron menu does not already own.
      if (event.key.toLowerCase() === 'z' && event.shiftKey) {
        event.preventDefault();
        editor.redo();
      }
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      editor.deleteSelection();
      return;
    }
    if (event.key === 'Escape') {
      editor.clearSelection();
      return;
    }

    const toolKeys: Record<string, ToolId> = {
      v: 'select', a: 'node', p: 'pen', n: 'pencil', b: 'brush',
      r: 'rect', e: 'ellipse', l: 'line', t: 'text', i: 'eyedropper', z: 'zoom',
    };
    const tool = toolKeys[event.key.toLowerCase()];
    if (tool) {
      event.preventDefault();
      editor.setTool(tool);
    }
  });

  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') canvas.setSpaceHeld(false);
  });

  window.addEventListener('blur', () => canvas.setSpaceHeld(false));

  // --- drag and drop -----------------------------------------------------
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    // `File.path` was removed in Electron 32; the preload resolves the real
    // path through webUtils instead.
    const paths = [...(event.dataTransfer?.files ?? [])]
      .map((file) => window.vectar.pathForFile(file))
      .filter((path): path is string => typeof path === 'string' && path.length > 0);
    if (paths.length === 0) {
      editor.setStatus('Could not read the dropped file');
      return;
    }
    void (async () => {
      for (const path of paths) {
        const encoding = /\.(svg|vectar)$/i.test(path) ? 'utf8' : 'base64';
        const file = await window.vectar.readFile(path, encoding);
        if (file) await files.importDropped(file);
      }
    })();
  });

  // --- unsaved changes on close -----------------------------------------
  window.vectar.onRequestClose(() => files.confirmDiscard());

  canvas.zoomFit();
  editor.setStatus('Ready. Press F1 for shortcuts.');
}

main();
