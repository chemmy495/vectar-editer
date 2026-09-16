import { app, BrowserWindow, dialog, ipcMain, type FileFilter } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { buildMenu } from './menu.ts';
import { CHANNELS, type OpenFilter, type OpenedFile, type SaveRequest, type SaveResult } from './ipc.ts';

const RASTER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'];

const FILTERS: Record<OpenFilter, FileFilter[]> = {
  vectar: [{ name: 'Vectar Document', extensions: ['vectar'] }],
  vector: [
    { name: 'Vector Files', extensions: ['vectar', 'svg'] },
    { name: 'Vectar Document', extensions: ['vectar'] },
    { name: 'SVG', extensions: ['svg'] },
  ],
  raster: [{ name: 'Images', extensions: RASTER_EXTENSIONS }],
  all: [
    { name: 'All Supported', extensions: ['vectar', 'svg', ...RASTER_EXTENSIONS] },
    { name: 'Vectar Document', extensions: ['vectar'] },
    { name: 'SVG', extensions: ['svg'] },
    { name: 'Images', extensions: RASTER_EXTENSIONS },
    { name: 'All Files', extensions: ['*'] },
  ],
};

const SAVE_FILTERS: Record<SaveRequest['kind'], FileFilter[]> = {
  vectar: [{ name: 'Vectar Document', extensions: ['vectar'] }],
  svg: [{ name: 'SVG', extensions: ['svg'] }],
  png: [{ name: 'PNG Image', extensions: ['png'] }],
  jpeg: [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }],
  webp: [{ name: 'WebP Image', extensions: ['webp'] }],
  bmp: [{ name: 'Bitmap Image', extensions: ['bmp'] }],
  pdf: [{ name: 'PDF Document', extensions: ['pdf'] }],
};

let mainWindow: BrowserWindow | null = null;
/** Set once the renderer has agreed the window may close. */
let closeApproved = false;

/** Text formats are read as UTF-8; everything else comes back base64. */
function encodingFor(path: string): 'utf8' | 'base64' {
  const extension = extname(path).slice(1).toLowerCase();
  return extension === 'svg' || extension === 'vectar' ? 'utf8' : 'base64';
}

async function readAsOpenedFile(path: string, encoding?: 'utf8' | 'base64'): Promise<OpenedFile> {
  const resolved = encoding ?? encodingFor(path);
  const buffer = await readFile(path);
  return {
    path,
    name: basename(path),
    data: resolved === 'utf8' ? buffer.toString('utf8') : buffer.toString('base64'),
    encoding: resolved,
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'Vectar Editor',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow.setMenu(buildMenu(mainWindow));

  // Give the renderer a chance to prompt about unsaved changes.
  mainWindow.on('close', (event) => {
    if (closeApproved || !mainWindow) return;
    event.preventDefault();
    mainWindow.webContents.send(CHANNELS.requestClose);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle(CHANNELS.openFile, async (_event, filter: OpenFilter): Promise<OpenedFile[] | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: FILTERS[filter] ?? FILTERS.all,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return Promise.all(result.filePaths.map((path) => readAsOpenedFile(path)));
});

ipcMain.handle(
  CHANNELS.readFile,
  async (_event, path: string, encoding: 'utf8' | 'base64'): Promise<OpenedFile | null> => {
    try {
      return await readAsOpenedFile(path, encoding);
    } catch {
      return null;
    }
  },
);

ipcMain.handle(CHANNELS.saveFile, async (_event, request: SaveRequest): Promise<SaveResult> => {
  if (!mainWindow) return { cancelled: true };
  let path = request.path;
  if (!path) {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: request.defaultName,
      filters: SAVE_FILTERS[request.kind] ?? [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    path = result.filePath;
  }
  const buffer = Buffer.from(request.data, request.encoding === 'base64' ? 'base64' : 'utf8');
  await writeFile(path, buffer);
  return { path };
});

ipcMain.handle(
  CHANNELS.messageBox,
  async (
    _event,
    options: { type: 'info' | 'warning' | 'error' | 'question'; message: string; detail?: string; buttons?: string[] },
  ): Promise<number> => {
    if (!mainWindow) return 0;
    const result = await dialog.showMessageBox(mainWindow, {
      type: options.type,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons ?? ['OK'],
      defaultId: 0,
      cancelId: (options.buttons?.length ?? 1) - 1,
    });
    return result.response;
  },
);

ipcMain.on(CHANNELS.setTitle, (_event, title: string, dirty: boolean) => {
  mainWindow?.setTitle(`${dirty ? '* ' : ''}${title} - Vectar Editor`);
});

ipcMain.on(CHANNELS.confirmClose, (_event, mayClose: boolean) => {
  if (!mayClose) return;
  closeApproved = true;
  mainWindow?.close();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
