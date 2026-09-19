import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS, type MenuCommand, type MessageBoxOptions, type OpenFilter, type OpenedFile, type SaveRequest, type SaveResult } from './ipc.ts';

/**
 * The only surface the renderer gets onto Node. Everything is funnelled
 * through named channels so the renderer stays sandboxed.
 */
const api = {
  openFile: (filter: OpenFilter): Promise<OpenedFile[] | null> =>
    ipcRenderer.invoke(CHANNELS.openFile, filter),

  readFile: (path: string, encoding: 'utf8' | 'base64'): Promise<OpenedFile | null> =>
    ipcRenderer.invoke(CHANNELS.readFile, path, encoding),

  saveFile: (request: SaveRequest): Promise<SaveResult> =>
    ipcRenderer.invoke(CHANNELS.saveFile, request),

  setTitle: (title: string, dirty: boolean): void => {
    ipcRenderer.send(CHANNELS.setTitle, title, dirty);
  },

  messageBox: (options: MessageBoxOptions): Promise<number> =>
    ipcRenderer.invoke(CHANNELS.messageBox, options),

  /** Confirms an unsaved-changes prompt before the window closes. */
  onRequestClose: (handler: () => Promise<boolean>): void => {
    ipcRenderer.on(CHANNELS.requestClose, async () => {
      const mayClose = await handler();
      ipcRenderer.send(CHANNELS.confirmClose, mayClose);
    });
  },

  onMenuCommand: (handler: (command: MenuCommand) => void): void => {
    ipcRenderer.on(CHANNELS.menuCommand, (_event, command: MenuCommand) => handler(command));
  },

  /**
   * Absolute path of a dropped or picked File. Electron 32 removed the
   * non-standard `File.path` property, and this is its replacement; it has to
   * run here because `webUtils` is not available to the sandboxed page.
   */
  pathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
};

contextBridge.exposeInMainWorld('vectar', api);

export type VectarApi = typeof api;
