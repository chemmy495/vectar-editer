import { byId, h } from './dom.ts';
import { Subscriptions, disposeAll, type Component } from './lifecycle.ts';
import { showDialog, showMessage } from './dialog.ts';
import { CanvasView } from './canvas.ts';
import { createFileOperations } from './files.ts';
import { createToolbar } from './panels/toolbar.ts';
import { createLayersPanel } from './panels/layers.ts';
import { createPropertiesPanel } from './panels/properties.ts';
import { createStatusBar } from './panels/statusbar.ts';
import { createSelectTool } from './tools/select.ts';
import { createAnchorTool } from './tools/anchor.ts';
import { createPenTool } from './tools/pen.ts';
import { createFreehandTool } from './tools/freehand.ts';
import { createShapeTool } from './tools/shape.ts';
import { createTextTool } from './tools/text.ts';
import { createEyedropperTool, createPanTool, createZoomTool } from './tools/utility.ts';
import {
  clearFlagEverywhere, convertSelectionToPaths, deleteSelection, duplicate,
  groupSelection, paste, reorderSelection, reverseSelectedPaths, setSelectionFlag,
  simplifySelectedPaths, ungroupSelection,
} from './editing.ts';
import * as commands from '../core/model/commands.ts';
import type { MenuCommand } from '../main/ipc.ts';
import type { ToolId } from './state/tool-settings.ts';
import { createEditorContext } from './state/context.ts';

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
  /** Everything the shell itself subscribes to, released on teardown. */
  const subscriptions = new Subscriptions();
  const editor = createEditorContext();
  const canvas = new CanvasView(editor, byId('viewport'));
  const files = createFileOperations(editor, canvas);

  // --- tools -------------------------------------------------------------
  canvas.registerTool(createSelectTool(editor, canvas));
  canvas.registerTool(createAnchorTool(editor, canvas));
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

  editor.events.bind(subscriptions, ['tool'], () => canvas.setActiveTool(editor.tools.active));
  canvas.setActiveTool(editor.tools.active);

  // --- panels ------------------------------------------------------------
  const components: Component[] = [
    canvas,
    createToolbar(editor, byId('toolbar')),
    createPropertiesPanel(editor, byId('properties')),
    createLayersPanel(editor, byId('layers')),
    createStatusBar(editor, byId('statusbar')),
  ];

  // --- window title ------------------------------------------------------
  const updateTitle = () => window.vectar.setTitle(editor.docs.name, editor.docs.dirty);
  editor.events.bind(subscriptions, ['document'], updateTitle);
  updateTitle();

  // Release everything on teardown, so a reload leaves nothing behind.
  subscriptions.addEventListener(window, 'pagehide', () => {
    subscriptions.dispose();
    disposeAll(components);
  });

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
      editor.tools.setActive(tool);
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

      case 'edit.undo': editor.docs.undo(); break;
      case 'edit.redo': editor.docs.redo(); break;
      case 'edit.cut': editor.clipboard.cut(); break;
      case 'edit.copy': editor.clipboard.copy(); break;
      case 'edit.paste': paste(editor); break;
      case 'edit.duplicate': duplicate(editor); break;
      case 'edit.delete': deleteSelection(editor); break;
      case 'edit.selectAll': editor.selection.selectAll(); break;
      case 'edit.deselect': editor.selection.clear(); break;

      case 'view.zoomIn': editor.view.zoomBy(1.25); break;
      case 'view.zoomOut': editor.view.zoomBy(1 / 1.25); break;
      case 'view.zoomFit': canvas.zoomFit(); break;
      case 'view.zoomActual': editor.view.setZoom(1); break;
      case 'view.toggleGrid': editor.view.toggleGrid(); break;
      case 'view.toggleSnap': editor.view.toggleSnap(); break;
      case 'view.toggleRulers': editor.view.toggleRulers(); break;

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
      const added = commands.addLayer(editor.docs.document);
      editor.docs.transaction('Add layer', () => editor.docs.run(added.command));
      editor.selection.setActiveLayer(added.layer.id);
    } else {
      const command = commands.removeLayer(editor.docs.document, editor.selection.activeLayerId);
      if (!command) {
        editor.status.set('A document needs at least one layer');
        return;
      }
      editor.docs.transaction('Delete layer', () => editor.docs.run(command));
      editor.selection.setActiveLayer(editor.docs.document.layers[0]?.id ?? '');
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
        editor.docs.redo();
      }
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelection(editor);
      return;
    }
    if (event.key === 'Escape') {
      editor.selection.clear();
      return;
    }

    const toolKeys: Record<string, ToolId> = {
      v: 'select', a: 'node', p: 'pen', n: 'pencil', b: 'brush',
      r: 'rect', e: 'ellipse', l: 'line', t: 'text', i: 'eyedropper', z: 'zoom',
    };
    const tool = toolKeys[event.key.toLowerCase()];
    if (tool) {
      event.preventDefault();
      editor.tools.setActive(tool);
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
      editor.status.set('Could not read the dropped file');
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
  editor.status.set('Ready. Press F1 for shortcuts.');
}

main();
