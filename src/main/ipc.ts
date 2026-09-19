/** Channel names and payload types shared by the main and renderer processes. */

export type OpenFilter = 'vectar' | 'vector' | 'raster' | 'all';

export type OpenedFile = {
  path: string;
  name: string;
  /** Text for SVG and .vectar files, base64 for raster images. */
  data: string;
  encoding: 'utf8' | 'base64';
};

export type SaveRequest = {
  /** Suggested file name, without a directory. */
  defaultName: string;
  /** File type used to build the dialog filters. */
  kind: 'vectar' | 'svg' | 'png' | 'jpeg' | 'webp' | 'bmp' | 'pdf';
  data: string;
  encoding: 'utf8' | 'base64';
  /** Reuse this path instead of showing a dialog. */
  path?: string;
};

export type SaveResult =
  | { path: string }
  | { cancelled: true }
  /** The user picked a destination but the write failed; already reported. */
  | { error: string };

export type MessageBoxOptions = {
  type: 'info' | 'warning' | 'error' | 'question';
  message: string;
  detail?: string;
  buttons?: string[];
};

/** Commands the application menu sends to the renderer. */
export type MenuCommand =
  | 'file.new' | 'file.open' | 'file.save' | 'file.saveAs' | 'file.importImage'
  | 'file.importSvg' | 'file.export'
  | 'edit.undo' | 'edit.redo' | 'edit.cut' | 'edit.copy' | 'edit.paste'
  | 'edit.duplicate' | 'edit.delete' | 'edit.selectAll' | 'edit.deselect'
  | 'view.zoomIn' | 'view.zoomOut' | 'view.zoomFit' | 'view.zoomActual'
  | 'view.toggleGrid' | 'view.toggleSnap' | 'view.toggleRulers'
  | 'object.group' | 'object.ungroup' | 'object.front' | 'object.back'
  | 'object.forward' | 'object.backward' | 'object.lock' | 'object.unlockAll'
  | 'object.hide' | 'object.showAll'
  | 'path.reverse' | 'path.simplify' | 'path.toPath'
  | 'layer.add' | 'layer.delete'
  | 'tool.select' | 'tool.node' | 'tool.pen' | 'tool.pencil' | 'tool.brush'
  | 'tool.rect' | 'tool.ellipse' | 'tool.polygon' | 'tool.star' | 'tool.line'
  | 'tool.text' | 'tool.eyedropper' | 'tool.zoom' | 'tool.pan'
  | 'help.about' | 'help.shortcuts';

export const CHANNELS = {
  openFile: 'vectar:openFile',
  saveFile: 'vectar:saveFile',
  readFile: 'vectar:readFile',
  menuCommand: 'vectar:menuCommand',
  setTitle: 'vectar:setTitle',
  confirmClose: 'vectar:confirmClose',
  requestClose: 'vectar:requestClose',
  messageBox: 'vectar:messageBox',
} as const;
