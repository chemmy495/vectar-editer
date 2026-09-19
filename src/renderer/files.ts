import { scaling } from '../core/geometry/matrix.ts';
import { documentPixelSize, createDocument } from '../core/model/document.ts';
import { createGroupNode, createImageNode, type SceneNode } from '../core/model/node.ts';
import { importSvg } from '../core/io/svg/import.ts';
import { exportSvg } from '../core/io/svg/export.ts';
import { exportPdf } from '../core/io/pdf/export.ts';
import { parseDocument, serializeDocument } from '../core/io/vectar.ts';
import { renderForExport } from '../core/render/render.ts';
import { traceImage, TRACE_PRESETS, DEFAULT_TRACE_OPTIONS, type TraceOptions } from '../core/trace/trace.ts';
import type { ImageData8 } from '../core/trace/quantize.ts';
import type { Editor } from './editor.ts';
import type { CanvasView } from './canvas.ts';
import { showDialog, showMessage, showProgress, modalActions } from './dialog.ts';
import { button, checkbox, field, h, numberInput, select } from './dom.ts';
import type { MenuCommand, MessageBoxOptions, OpenFilter, OpenedFile, SaveRequest, SaveResult } from '../main/ipc.ts';

/**
 * The preload bridge. The signatures are built from the shared IPC types so
 * this declaration cannot drift away from what preload actually exposes.
 */
declare global {
  interface Window {
    vectar: {
      openFile(filter: OpenFilter): Promise<OpenedFile[] | null>;
      readFile(path: string, encoding: 'utf8' | 'base64'): Promise<OpenedFile | null>;
      saveFile(request: SaveRequest): Promise<SaveResult>;
      setTitle(title: string, dirty: boolean): void;
      messageBox(options: MessageBoxOptions): Promise<number>;
      onRequestClose(handler: () => Promise<boolean>): void;
      onMenuCommand(handler: (command: MenuCommand) => void): void;
      pathForFile(file: File): string | null;
    };
  }
}

/** True when a save actually wrote a file. */
const didSave = (result: SaveResult): result is { path: string } => 'path' in result;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp', gif: 'image/gif', avif: 'image/avif',
};

const extensionOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? '';

/** Decodes a base64 raster file into pixels the tracer can read. */
async function decodeImage(file: OpenedFile): Promise<{ pixels: ImageData8; dataUrl: string }> {
  const mime = MIME_BY_EXTENSION[extensionOf(file.name)] ?? 'image/png';
  const dataUrl = `data:${mime};base64,${file.data}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Could not decode ${file.name}`));
    image.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This system does not provide a 2D canvas context.');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    pixels: { width: canvas.width, height: canvas.height, data: data.data },
    dataUrl,
  };
}

/** Converts a blob into base64 for the save IPC call. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export type FileOperations = ReturnType<typeof createFileOperations>;

export function createFileOperations(editor: Editor, canvas: CanvasView) {
  /** Prompts to save when the document has unsaved changes. */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!editor.dirty) return true;
    const answer = await window.vectar.messageBox({
      type: 'question',
      message: `Save changes to "${editor.documentName()}"?`,
      detail: 'Your changes will be lost if you do not save them.',
      buttons: ['Save', "Don't Save", 'Cancel'],
    });
    if (answer === 2) return false;
    if (answer === 0) return saveDocument(false);
    return true;
  };

  const newDocument = async (): Promise<void> => {
    if (!(await confirmDiscard())) return;
    const size = await showDialog<{ width: number; height: number; name: string }>('New Document', (close) => {
      let width = 1280;
      let height = 800;
      let name = 'Untitled';
      const presets: Array<{ label: string; width: number; height: number }> = [
        { label: 'Screen 1280 x 800', width: 1280, height: 800 },
        { label: 'Full HD 1920 x 1080', width: 1920, height: 1080 },
        { label: 'Square 1000 x 1000', width: 1000, height: 1000 },
        { label: 'A4 portrait (96 dpi)', width: 794, height: 1123 },
        { label: 'A4 landscape (96 dpi)', width: 1123, height: 794 },
      ];
      const widthInput = numberInput(width, (v) => { width = Math.max(1, v); }, { min: 1 });
      const heightInput = numberInput(height, (v) => { height = Math.max(1, v); }, { min: 1 });

      return h('div', { class: 'modal-body' }, [
        field('Preset', select('', [{ value: '', label: 'Custom' }, ...presets.map((p) => ({ value: p.label, label: p.label }))], (value) => {
          const preset = presets.find((p) => p.label === value);
          if (!preset) return;
          width = preset.width;
          height = preset.height;
          widthInput.value = String(width);
          heightInput.value = String(height);
        })),
        field('Name', h('input', {
          class: 'text-input',
          value: name,
          onchange: (event: Event) => { name = (event.target as HTMLInputElement).value; },
        })),
        h('div', { class: 'field-grid' }, [field('Width', widthInput), field('Height', heightInput)]),
        modalActions('Create', () => close({ width, height, name }), () => close(null)),
      ]);
    });
    if (!size) return;
    editor.loadDocument(createDocument(size.width, size.height, size.name || 'Untitled'), null);
    canvas.zoomFit();
    editor.setStatus('New document created');
  };

  /** Turns an opened file into a document or into nodes added to this one. */
  const loadOpenedFile = async (file: OpenedFile, mode: 'open' | 'import'): Promise<void> => {
    const extension = extensionOf(file.name);

    if (extension === 'vectar') {
      const { document: parsed, warnings } = parseDocument(file.data);
      if (mode === 'open') {
        editor.loadDocument(parsed, file.path);
        canvas.zoomFit();
      } else {
        const nodes = parsed.layers.flatMap((layer) => layer.children);
        editor.addNodes(nodes, 'Import document');
      }
      if (warnings.length > 0) await showMessage('Opened with warnings', warnings);
      return;
    }

    if (extension === 'svg') {
      const { document: parsed, warnings } = importSvg(file.data, file.name.replace(/\.svg$/i, ''));
      if (mode === 'open') {
        editor.loadDocument(parsed, file.path);
        canvas.zoomFit();
      } else {
        // Keep the imported artwork together and centred on the canvas.
        const group = createGroupNode(parsed.layers.flatMap((layer) => layer.children), file.name);
        group.transform = parsed.layers[0]?.transform ?? group.transform;
        editor.addNodes([group], 'Import SVG');
      }
      if (warnings.length > 0) await showMessage('Imported with warnings', warnings);
      return;
    }

    await importRaster(file, mode);
  };

  /** Shows the vectorization dialog and inserts the traced shapes. */
  const importRaster = async (file: OpenedFile, mode: 'open' | 'import'): Promise<void> => {
    let decoded: { pixels: ImageData8; dataUrl: string };
    try {
      decoded = await decodeImage(file);
    } catch (error) {
      await showMessage('Could not open image', [(error as Error).message]);
      return;
    }

    const choice = await showTraceDialog(file.name, decoded.pixels);
    if (!choice) return;

    if (choice.mode === 'place') {
      const node = createImageNode(decoded.dataUrl, decoded.pixels.width, decoded.pixels.height, file.name);
      if (mode === 'open') {
        const doc = createDocument(decoded.pixels.width, decoded.pixels.height, file.name);
        doc.layers[0].children.push(node);
        editor.loadDocument(doc, null);
        canvas.zoomFit();
      } else {
        editor.addNodes([node], 'Place image');
      }
      return;
    }

    const progress = showProgress(`Vectorizing ${file.name}`);
    // Yield once so the progress dialog paints before the work begins.
    await new Promise((resolve) => setTimeout(resolve, 16));

    let result;
    try {
      result = traceImage(decoded.pixels, {
        ...choice.options,
        onProgress: (fraction, message) => progress.update(fraction, message),
      });
    } catch (error) {
      progress.close();
      await showMessage('Vectorization failed', [(error as Error).message]);
      return;
    }
    progress.close();

    if (result.nodes.length === 0) {
      await showMessage('Nothing to trace', ['No shapes were found. Try raising the colour count or lowering the minimum area.']);
      return;
    }

    const group = createGroupNode(result.nodes as SceneNode[], file.name);
    if (mode === 'open') {
      const doc = createDocument(decoded.pixels.width, decoded.pixels.height, file.name);
      doc.layers[0].children.push(group);
      editor.loadDocument(doc, null);
      canvas.zoomFit();
    } else {
      // Scale the trace down if it is much larger than the current canvas.
      const { width, height } = documentPixelSize(editor.document);
      const factor = Math.min(1, width / decoded.pixels.width, height / decoded.pixels.height);
      if (factor < 1) group.transform = scaling(factor);
      editor.addNodes([group], 'Vectorize image');
    }
    editor.setStatus(
      `Traced ${result.shapeCount} shapes (${result.anchorCount} anchors) in ${(result.elapsedMs / 1000).toFixed(1)}s`,
    );
  };

  const openFile = async (): Promise<void> => {
    if (!(await confirmDiscard())) return;
    const files = await window.vectar.openFile('all');
    if (!files || files.length === 0) return;
    await loadOpenedFile(files[0], 'open');
    for (const file of files.slice(1)) await loadOpenedFile(file, 'import');
  };

  const importImage = async (): Promise<void> => {
    const files = await window.vectar.openFile('raster');
    if (!files) return;
    for (const file of files) await importRaster(file, 'import');
  };

  const importSvgFile = async (): Promise<void> => {
    const files = await window.vectar.openFile('vector');
    if (!files) return;
    for (const file of files) await loadOpenedFile(file, 'import');
  };

  const saveDocument = async (forceDialog: boolean): Promise<boolean> => {
    const request: SaveRequest = {
      defaultName: `${editor.documentName()}.vectar`,
      kind: 'vectar',
      data: serializeDocument(editor.document, true),
      encoding: 'utf8',
      path: forceDialog ? undefined : (editor.filePath ?? undefined),
    };
    const result = await window.vectar.saveFile(request);
    if (!didSave(result)) return false;
    editor.markSaved(result.path);
    editor.setStatus(`Saved to ${result.path}`);
    return true;
  };

  /** Rasterizes the document at `scale` and returns the encoded bytes. */
  const renderRaster = async (
    format: 'png' | 'jpeg' | 'webp',
    scale: number,
    quality: number,
    transparent: boolean,
  ): Promise<Blob> => {
    const { width, height } = documentPixelSize(editor.document);
    const target = document.createElement('canvas');
    target.width = Math.max(1, Math.round(width * scale));
    target.height = Math.max(1, Math.round(height * scale));
    const context = target.getContext('2d');
    if (!context) throw new Error('This system does not provide a 2D canvas context.');

    // JPEG has no alpha channel, so it always needs an opaque backdrop.
    if (!transparent || format === 'jpeg') {
      context.fillStyle = editor.document.background
        ? `rgb(${editor.document.background.r}, ${editor.document.background.g}, ${editor.document.background.b})`
        : '#ffffff';
      context.fillRect(0, 0, target.width, target.height);
    }

    renderForExport(context, editor.document, scale, {
      drawBackground: transparent && format !== 'jpeg' ? false : true,
      resolveImage: (href) => {
        const image = new Image();
        image.src = href;
        return image.complete ? image : null;
      },
    });

    const blob = await new Promise<Blob | null>((resolve) => {
      target.toBlob(resolve, `image/${format}`, quality);
    });
    if (!blob) throw new Error(`Could not encode the image as ${format}.`);
    return blob;
  };

  const exportDocument = async (): Promise<void> => {
    const choice = await showExportDialog(editor);
    if (!choice) return;

    const baseName = editor.documentName().replace(/\.[^.]+$/, '');

    if (choice.format === 'svg') {
      const result = await window.vectar.saveFile({
        defaultName: `${baseName}.svg`,
        kind: 'svg',
        data: exportSvg(editor.document, { includeBackground: choice.includeBackground }),
        encoding: 'utf8',
      });
      if (didSave(result)) editor.setStatus(`Exported ${result.path}`);
      return;
    }

    if (choice.format === 'pdf') {
      const bytes = exportPdf(editor.document, { pointsPerPixel: choice.scale });
      const result = await window.vectar.saveFile({
        defaultName: `${baseName}.pdf`,
        kind: 'pdf',
        data: bytesToBase64(bytes),
        encoding: 'base64',
      });
      if (didSave(result)) editor.setStatus(`Exported ${result.path}`);
      return;
    }

    if (choice.format === 'bmp') {
      // Canvas cannot encode BMP, so the pixels are packed by hand.
      const blob = await renderRaster('png', choice.scale, 1, false);
      const bitmap = await createImageBitmap(blob);
      const scratch = document.createElement('canvas');
      scratch.width = bitmap.width;
      scratch.height = bitmap.height;
      const context = scratch.getContext('2d');
      if (!context) return;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, scratch.width, scratch.height);
      const bytes = encodeBmp(pixels.data, scratch.width, scratch.height);
      const result = await window.vectar.saveFile({
        defaultName: `${baseName}.bmp`,
        kind: 'bmp',
        data: bytesToBase64(bytes),
        encoding: 'base64',
      });
      if (didSave(result)) editor.setStatus(`Exported ${result.path}`);
      return;
    }

    const blob = await renderRaster(choice.format, choice.scale, choice.quality, choice.transparent);
    const result = await window.vectar.saveFile({
      defaultName: `${baseName}.${choice.format === 'jpeg' ? 'jpg' : choice.format}`,
      kind: choice.format,
      data: await blobToBase64(blob),
      encoding: 'base64',
    });
    if (didSave(result)) editor.setStatus(`Exported ${result.path}`);
  };

  return {
    confirmDiscard,
    newDocument,
    openFile,
    importImage,
    importSvgFile,
    saveDocument,
    exportDocument,
    /** Handles a file dropped onto the window, adding it to the document. */
    importDropped: (file: OpenedFile) => loadOpenedFile(file, 'import'),
  };
}

type TraceChoice =
  | { mode: 'place' }
  | { mode: 'trace'; options: Partial<TraceOptions> };

/** Import dialog: place the bitmap as-is, or vectorize it with these settings. */
function showTraceDialog(name: string, pixels: ImageData8): Promise<TraceChoice | null> {
  return showDialog<TraceChoice>(
    `Import ${name}`,
    (close) => {
      const options: TraceOptions = { ...DEFAULT_TRACE_OPTIONS };
      const presetNames = Object.keys(TRACE_PRESETS);

      const colorsInput = numberInput(options.maxColors, (v) => { options.maxColors = Math.max(1, Math.round(v)); }, { min: 1, max: 256 });
      const minAreaInput = numberInput(options.minArea, (v) => { options.minArea = Math.max(1, v); }, { min: 1 });
      const simplifyInput = numberInput(options.simplifyTolerance, (v) => { options.simplifyTolerance = Math.max(0, v); }, { min: 0, step: 0.1 });
      const fitInput = numberInput(options.fitTolerance, (v) => { options.fitTolerance = Math.max(0, v); }, { min: 0, step: 0.1 });
      const blurInput = numberInput(options.blurPasses, (v) => { options.blurPasses = Math.max(0, Math.round(v)); }, { min: 0, max: 4 });

      const applyPreset = (preset: string) => {
        Object.assign(options, DEFAULT_TRACE_OPTIONS, TRACE_PRESETS[preset] ?? {});
        colorsInput.value = String(options.maxColors);
        minAreaInput.value = String(options.minArea);
        simplifyInput.value = String(options.simplifyTolerance);
        fitInput.value = String(options.fitTolerance);
        blurInput.value = String(options.blurPasses);
      };

      const megapixels = (pixels.width * pixels.height) / 1_000_000;
      const warning = megapixels > 4
        ? h('p', { class: 'modal-note', text: `This image is ${pixels.width} x ${pixels.height}. Tracing it may take a while.` })
        : h('p', { class: 'modal-note', text: `${pixels.width} x ${pixels.height} pixels` });

      return h('div', { class: 'modal-body' }, [
        warning,
        field('Preset', select(presetNames[0], presetNames.map((p) => ({ value: p, label: p })), applyPreset)),
        h('div', { class: 'field-grid' }, [
          field('Colours', colorsInput),
          field('Min area (px)', minAreaInput),
          field('Simplify', simplifyInput),
          field('Curve fit', fitInput),
          field('Blur passes', blurInput),
        ]),
        checkbox(options.ignoreBackground, 'Drop background colour', (v) => { options.ignoreBackground = v; }),
        checkbox(options.curves, 'Fit bezier curves', (v) => { options.curves = v; }),
        h('div', { class: 'modal-actions' }, [
          button('Cancel', () => close(null), { class: 'button' }),
          button('Place as image', () => close({ mode: 'place' }), { class: 'button' }),
          button('Vectorize', () => close({ mode: 'trace', options: { ...options } }), { class: 'button primary' }),
        ]),
      ]);
    },
    { width: 460 },
  );
}

type ExportChoice = {
  format: 'svg' | 'pdf' | 'png' | 'jpeg' | 'webp' | 'bmp';
  scale: number;
  quality: number;
  transparent: boolean;
  includeBackground: boolean;
};

function showExportDialog(editor: Editor): Promise<ExportChoice | null> {
  return showDialog<ExportChoice>(
    'Export',
    (close) => {
      const choice: ExportChoice = {
        format: 'png',
        scale: 1,
        quality: 0.92,
        transparent: false,
        includeBackground: true,
      };
      const { width, height } = documentPixelSize(editor.document);
      const sizeLabel = h('p', { class: 'modal-note', text: '' });
      const updateSize = () => {
        sizeLabel.textContent =
          choice.format === 'svg'
            ? 'Vector output at the document size.'
            : choice.format === 'pdf'
              ? `Vector PDF, ${Math.round(width * choice.scale)} x ${Math.round(height * choice.scale)} pt`
              : `Output ${Math.round(width * choice.scale)} x ${Math.round(height * choice.scale)} px`;
      };
      updateSize();

      return h('div', { class: 'modal-body' }, [
        field('Format', select(choice.format, [
          { value: 'png', label: 'PNG (transparency)' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
          { value: 'bmp', label: 'BMP' },
          { value: 'svg', label: 'SVG (vector)' },
          { value: 'pdf', label: 'PDF (vector)' },
        ], (format) => {
          choice.format = format;
          updateSize();
        })),
        field('Scale', select('1', [
          { value: '0.5', label: '0.5x' },
          { value: '1', label: '1x' },
          { value: '2', label: '2x' },
          { value: '3', label: '3x' },
          { value: '4', label: '4x' },
        ], (value) => {
          choice.scale = Number(value);
          updateSize();
        })),
        field('JPEG/WebP quality', numberInput(92, (v) => {
          choice.quality = Math.max(0.1, Math.min(1, v / 100));
        }, { min: 10, max: 100 })),
        checkbox(false, 'Transparent background (PNG/WebP)', (v) => { choice.transparent = v; }),
        checkbox(true, 'Include background in SVG', (v) => { choice.includeBackground = v; }),
        sizeLabel,
        modalActions('Export', () => close({ ...choice }), () => close(null)),
      ]);
    },
    { width: 420 },
  );
}

/**
 * Encodes RGBA pixels as an uncompressed 24-bit BMP, which the canvas API
 * cannot produce on its own.
 */
export function encodeBmp(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);

  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  // BMP rows run bottom-up and store colours as BGR.
  for (let y = 0; y < height; y++) {
    const sourceRow = (height - 1 - y) * width * 4;
    let target = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * 4;
      const alpha = pixels[source + 3] / 255;
      // Composite onto white, since 24-bit BMP has no alpha channel.
      bytes[target++] = Math.round(pixels[source + 2] * alpha + 255 * (1 - alpha));
      bytes[target++] = Math.round(pixels[source + 1] * alpha + 255 * (1 - alpha));
      bytes[target++] = Math.round(pixels[source] * alpha + 255 * (1 - alpha));
    }
  }
  return bytes;
}
