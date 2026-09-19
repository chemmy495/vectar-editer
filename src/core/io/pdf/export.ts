import { compose, identity, type Matrix } from '../../geometry/matrix.ts';
import { documentPixelSize, type VectarDocument } from '../../model/document.ts';
import { isContainer, type SceneNode, type TextNode } from '../../model/node.ts';
import { isFillVisible, isStrokeVisible, paintColor, type Fill, type Stroke } from '../../model/style.ts';
import { segmentCount, segmentAt, type PathData } from '../../path/path.ts';

/**
 * A minimal PDF 1.4 writer that emits the document as real vector content
 * rather than a rasterized image. Gradients are approximated by their first
 * stop, and text uses the standard Helvetica/Times families.
 */

const n = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** PDF colours are 0-1 per channel. */
const channel = (value: number): string => n(Math.max(0, Math.min(1, value / 255)));

const LINE_CAP = { butt: 0, round: 1, square: 2 } as const;
const LINE_JOIN = { miter: 0, round: 1, bevel: 2 } as const;

/** Maps a font family and weight onto one of the standard PDF base fonts. */
function baseFont(node: TextNode): string {
  const family = node.fontFamily.toLowerCase();
  const serif = /times|georgia|garamond|serif|mincho|明朝/.test(family) && !/sans/.test(family);
  const mono = /mono|courier|consolas|gothic code/.test(family);
  const bold = node.fontWeight >= 600;
  if (mono) return bold ? (node.italic ? 'Courier-BoldOblique' : 'Courier-Bold') : node.italic ? 'Courier-Oblique' : 'Courier';
  if (serif) return bold ? (node.italic ? 'Times-BoldItalic' : 'Times-Bold') : node.italic ? 'Times-Italic' : 'Times-Roman';
  return bold ? (node.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : node.italic ? 'Helvetica-Oblique' : 'Helvetica';
}

/** Escapes a string for a PDF literal, and drops characters WinAnsi cannot hold. */
function pdfString(text: string): string {
  let result = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '(' || ch === ')' || ch === '\\') result += `\\${ch}`;
    else if (code >= 32 && code <= 126) result += ch;
    else if (code >= 160 && code <= 255) result += `\\${code.toString(8).padStart(3, '0')}`;
    else result += '?'; // Outside WinAnsi: no embedded font to draw it with.
  }
  return result;
}

function pathOperators(path: PathData): string {
  const parts: string[] = [];
  for (const subpath of path.subpaths) {
    if (subpath.anchors.length === 0) continue;
    const start = subpath.anchors[0].point;
    parts.push(`${n(start.x)} ${n(start.y)} m`);
    const count = segmentCount(subpath);
    for (let i = 0; i < count; i++) {
      const curve = segmentAt(subpath, i);
      if (!curve) continue;
      const [, c1, c2, end] = curve;
      const from = subpath.anchors[i];
      const to = subpath.anchors[(i + 1) % subpath.anchors.length];
      const straight =
        from.outHandle.x === 0 && from.outHandle.y === 0 && to.inHandle.x === 0 && to.inHandle.y === 0;
      if (straight) parts.push(`${n(end.x)} ${n(end.y)} l`);
      else parts.push(`${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(end.x)} ${n(end.y)} c`);
    }
    if (subpath.closed) parts.push('h');
  }
  return parts.join('\n');
}

/** Emits the paint operator for the requested fill/stroke combination. */
function paintOperator(fill: Fill, stroke: Stroke): string | null {
  const hasFill = isFillVisible(fill);
  const hasStroke = isStrokeVisible(stroke);
  if (hasFill && hasStroke) return fill.rule === 'evenodd' ? 'B*' : 'B';
  if (hasFill) return fill.rule === 'evenodd' ? 'f*' : 'f';
  if (hasStroke) return 'S';
  return null;
}

type Context = {
  content: string[];
  /** Base font name to the resource name used in the content stream. */
  fonts: Map<string, string>;
  /** Alpha pair to its `/ExtGState` resource name. */
  alphaStates: Map<string, { name: string; fill: number; stroke: number }>;
};

function setStyle(context: Context, fill: Fill, stroke: Stroke, opacity: number): void {
  const fillColor = paintColor(fill.paint);
  const strokeColor = paintColor(stroke.paint);
  if (fillColor) {
    context.content.push(`${channel(fillColor.r)} ${channel(fillColor.g)} ${channel(fillColor.b)} rg`);
  }
  if (strokeColor) {
    context.content.push(`${channel(strokeColor.r)} ${channel(strokeColor.g)} ${channel(strokeColor.b)} RG`);
  }
  if (isStrokeVisible(stroke)) {
    context.content.push(`${n(stroke.width)} w`);
    context.content.push(`${LINE_CAP[stroke.cap]} J`);
    context.content.push(`${LINE_JOIN[stroke.join]} j`);
    if (stroke.join === 'miter') context.content.push(`${n(Math.max(1, stroke.miterLimit))} M`);
    if (stroke.dash.length > 0) {
      context.content.push(`[${stroke.dash.map(n).join(' ')}] ${n(stroke.dashOffset)} d`);
    } else {
      context.content.push('[] 0 d');
    }
  }

  const fillAlpha = (fillColor?.a ?? 1) * opacity;
  const strokeAlpha = (strokeColor?.a ?? 1) * opacity;
  if (fillAlpha < 1 || strokeAlpha < 1) {
    const key = `${n(fillAlpha)}_${n(strokeAlpha)}`;
    let state = context.alphaStates.get(key);
    if (!state) {
      state = { name: `GS${context.alphaStates.size + 1}`, fill: fillAlpha, stroke: strokeAlpha };
      context.alphaStates.set(key, state);
    }
    context.content.push(`/${state.name} gs`);
  } else {
    context.content.push('/GSopaque gs');
  }
}

function emitNode(node: SceneNode, parent: Matrix, context: Context, opacity: number): void {
  if (!node.visible || node.opacity === 0) return;
  const world = compose(parent, node.transform);
  const effectiveOpacity = opacity * node.opacity;

  if (isContainer(node)) {
    for (const child of node.children) emitNode(child, world, context, effectiveOpacity);
    return;
  }

  context.content.push('q');
  context.content.push(
    `${n(world.a)} ${n(world.b)} ${n(world.c)} ${n(world.d)} ${n(world.e)} ${n(world.f)} cm`,
  );

  if (node.type === 'path') {
    const operator = paintOperator(node.fill, node.stroke);
    if (operator) {
      setStyle(context, node.fill, node.stroke, effectiveOpacity);
      const operators = pathOperators(node.path);
      if (operators) {
        context.content.push(operators);
        context.content.push(operator);
      }
    }
  } else if (node.type === 'text') {
    const font = baseFont(node);
    let name = context.fonts.get(font);
    if (!name) {
      name = `F${context.fonts.size + 1}`;
      context.fonts.set(font, name);
    }
    setStyle(context, node.fill, node.stroke, effectiveOpacity);
    const lines = node.text.split('\n');
    context.content.push('BT');
    context.content.push(`/${name} ${n(node.fontSize)} Tf`);
    if (node.letterSpacing !== 0) context.content.push(`${n(node.letterSpacing)} Tc`);
    // PDF text runs bottom-up, so the vertical flip is undone around the baseline.
    context.content.push(`1 0 0 -1 ${n(node.x)} ${n(node.y)} Tm`);
    lines.forEach((line, index) => {
      if (index > 0) context.content.push(`0 ${n(-node.fontSize * node.lineHeight)} Td`);
      context.content.push(`(${pdfString(line)}) Tj`);
    });
    context.content.push('ET');
  }

  context.content.push('Q');
}

export type PdfExportOptions = {
  /** Output size in points; defaults to treating one pixel as one point. */
  pointsPerPixel?: number;
  title?: string;
};

/** Renders a document into a single-page PDF, returned as bytes. */
export function exportPdf(doc: VectarDocument, options: PdfExportOptions = {}): Uint8Array {
  const pointsPerPixel = options.pointsPerPixel ?? 1;
  const { width, height } = documentPixelSize(doc);
  const pageWidth = width * pointsPerPixel;
  const pageHeight = height * pointsPerPixel;

  const context: Context = { content: [], fonts: new Map(), alphaStates: new Map() };

  // PDF's y axis points up; flip once so document coordinates carry through.
  context.content.push('q');
  context.content.push(`${n(pointsPerPixel)} 0 0 ${n(-pointsPerPixel)} 0 ${n(pageHeight)} cm`);

  if (doc.background && doc.background.a > 0) {
    context.content.push(
      `${channel(doc.background.r)} ${channel(doc.background.g)} ${channel(doc.background.b)} rg`,
    );
    context.content.push(`0 0 ${n(width)} ${n(height)} re f`);
  }

  for (const layer of doc.layers) emitNode(layer, identity(), context, 1);
  context.content.push('Q');

  const stream = context.content.join('\n');

  // Object 1 catalog, 2 pages, 3 page, 4 contents, then fonts and ext states.
  const objects: string[] = [];
  const fontEntries = [...context.fonts.entries()];
  const alphaEntries = [...context.alphaStates.entries()];
  const firstFontObject = 5;
  const firstAlphaObject = firstFontObject + fontEntries.length;

  const fontResources = fontEntries
    .map(([, name], index) => `/${name} ${firstFontObject + index} 0 R`)
    .join(' ');
  const alphaResources = alphaEntries
    .map(([, state], index) => `/${state.name} ${firstAlphaObject + index} 0 R`)
    .join(' ');
  // A fully opaque state so a shape drawn after a translucent one resets.
  const opaqueObject = firstAlphaObject + alphaEntries.length;
  const allAlphaResources = `${alphaResources} /GSopaque ${opaqueObject} 0 R`.trim();

  const resourceParts = ['/ProcSet [/PDF /Text]'];
  if (fontResources) resourceParts.push(`/Font <<${fontResources}>>`);
  resourceParts.push(`/ExtGState <<${allAlphaResources}>>`);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageWidth)} ${n(pageHeight)}] ` +
      `/Resources << ${resourceParts.join(' ')} >> /Contents 4 0 R >>`,
  );
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  for (const [font, name] of fontEntries) {
    objects.push(`<< /Type /Font /Subtype /Type1 /Name /${name} /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
  }
  for (const [, alpha] of alphaEntries) {
    objects.push(`<< /Type /ExtGState /ca ${n(alpha.fill)} /CA ${n(alpha.stroke)} >>`);
  }
  objects.push('<< /Type /ExtGState /ca 1 /CA 1 >>');

  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  // Every character written below is Latin-1, so string length is byte length.
  const byteLength = (text: string): number => text.length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  // Latin-1 keeps the byte offsets recorded in the xref table accurate.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
