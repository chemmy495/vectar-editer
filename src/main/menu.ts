import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { CHANNELS, type MenuCommand } from './ipc.ts';

/** Builds the application menu. Every item forwards a command to the renderer. */
export function buildMenu(window: BrowserWindow): Menu {
  const send = (command: MenuCommand) => () => {
    window.webContents.send(CHANNELS.menuCommand, command);
  };

  const item = (
    label: string,
    command: MenuCommand,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({ label, accelerator, click: send(command) });

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        item('&New', 'file.new', 'CmdOrCtrl+N'),
        item('&Open...', 'file.open', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('&Save', 'file.save', 'CmdOrCtrl+S'),
        item('Save &As...', 'file.saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('&Import Image (Vectorize)...', 'file.importImage', 'CmdOrCtrl+Shift+I'),
        item('Import S&VG...', 'file.importSvg'),
        item('&Export...', 'file.export', 'CmdOrCtrl+E'),
        { type: 'separator' },
        { role: 'quit', label: 'E&xit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        item('&Undo', 'edit.undo', 'CmdOrCtrl+Z'),
        item('&Redo', 'edit.redo', 'CmdOrCtrl+Y'),
        { type: 'separator' },
        item('Cu&t', 'edit.cut', 'CmdOrCtrl+X'),
        item('&Copy', 'edit.copy', 'CmdOrCtrl+C'),
        item('&Paste', 'edit.paste', 'CmdOrCtrl+V'),
        item('D&uplicate', 'edit.duplicate', 'CmdOrCtrl+D'),
        item('&Delete', 'edit.delete', 'Delete'),
        { type: 'separator' },
        item('Select &All', 'edit.selectAll', 'CmdOrCtrl+A'),
        item('Deselect', 'edit.deselect', 'Escape'),
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Zoom &In', 'view.zoomIn', 'CmdOrCtrl+Plus'),
        item('Zoom &Out', 'view.zoomOut', 'CmdOrCtrl+-'),
        item('&Fit to Window', 'view.zoomFit', 'CmdOrCtrl+0'),
        item('&Actual Size', 'view.zoomActual', 'CmdOrCtrl+1'),
        { type: 'separator' },
        item('Show &Grid', 'view.toggleGrid', 'CmdOrCtrl+\''),
        item('&Snap to Grid', 'view.toggleSnap', 'CmdOrCtrl+Shift+\''),
        item('Show &Rulers', 'view.toggleRulers', 'CmdOrCtrl+R'),
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Object',
      submenu: [
        item('&Group', 'object.group', 'CmdOrCtrl+G'),
        item('&Ungroup', 'object.ungroup', 'CmdOrCtrl+Shift+G'),
        { type: 'separator' },
        item('Bring to &Front', 'object.front', 'CmdOrCtrl+Shift+Up'),
        item('Bring F&orward', 'object.forward', 'CmdOrCtrl+Up'),
        item('Send &Backward', 'object.backward', 'CmdOrCtrl+Down'),
        item('Send to Bac&k', 'object.back', 'CmdOrCtrl+Shift+Down'),
        { type: 'separator' },
        item('&Lock', 'object.lock', 'CmdOrCtrl+L'),
        item('Unlock All', 'object.unlockAll', 'CmdOrCtrl+Alt+L'),
        item('&Hide', 'object.hide', 'CmdOrCtrl+H'),
        item('Show All', 'object.showAll', 'CmdOrCtrl+Alt+H'),
      ],
    },
    {
      label: '&Path',
      submenu: [
        item('&Reverse Direction', 'path.reverse'),
        item('&Simplify', 'path.simplify', 'CmdOrCtrl+Shift+P'),
        item('Object to &Path', 'path.toPath', 'CmdOrCtrl+Shift+C'),
      ],
    },
    {
      label: '&Layer',
      submenu: [
        item('&Add Layer', 'layer.add', 'CmdOrCtrl+Shift+N'),
        item('&Delete Layer', 'layer.delete'),
      ],
    },
    {
      label: '&Tools',
      submenu: [
        item('&Select', 'tool.select', 'V'),
        item('&Node Edit', 'tool.node', 'A'),
        item('&Pen', 'tool.pen', 'P'),
        item('Pen&cil', 'tool.pencil', 'N'),
        item('&Brush', 'tool.brush', 'B'),
        { type: 'separator' },
        item('&Rectangle', 'tool.rect', 'R'),
        item('&Ellipse', 'tool.ellipse', 'E'),
        item('Pol&ygon', 'tool.polygon'),
        item('S&tar', 'tool.star'),
        item('&Line', 'tool.line', 'L'),
        { type: 'separator' },
        item('Te&xt', 'tool.text', 'T'),
        item('Eyedropper', 'tool.eyedropper', 'I'),
        item('Zoom', 'tool.zoom', 'Z'),
      ],
    },
    {
      label: '&Help',
      submenu: [
        item('&Keyboard Shortcuts', 'help.shortcuts', 'F1'),
        item('&About Vectar Editor', 'help.about'),
        {
          label: 'Project &Repository',
          click: () => {
            void shell.openExternal('https://github.com/chemmy495/vectar-editer');
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
    });
  }

  return Menu.buildFromTemplate(template);
}
