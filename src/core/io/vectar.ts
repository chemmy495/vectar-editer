import { createDocument, type Unit, type VectarDocument } from '../model/document.ts';
import { cloneNode, newId, type LayerNode, type SceneNode } from '../model/node.ts';
import { normalizeColor, type RGBA } from '../model/color.ts';
import { identity, type Matrix } from '../geometry/matrix.ts';
import type { Vec } from '../geometry/vec.ts';
import type { Anchor, PathData, SubPath } from '../path/path.ts';
import { noFill, noStroke, type BlendMode, type Fill, type GradientStop, type Paint, type Stroke } from '../model/style.ts';

/**
 * The native `.vectar` format is the document model serialized as JSON.
 * Reading is defensive: a file written by another version should still open,
 * with anything unrecognised replaced by a sane default.
 */

export const FILE_EXTENSION = 'vectar';

export function serializeDocument(doc: VectarDocument, pretty = false): string {
  return JSON.stringify(doc, null, pretty ? 2 : 0);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const boolOr = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const BLEND_MODES: readonly BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

const readBlendMode = (value: unknown): BlendMode =>
  typeof value === 'string' && (BLEND_MODES as readonly string[]).includes(value)
    ? (value as BlendMode)
    : 'normal';

function readMatrix(value: unknown): Matrix {
  if (!isRecord(value)) return identity();
  return {
    a: numberOr(value.a, 1),
    b: numberOr(value.b, 0),
    c: numberOr(value.c, 0),
    d: numberOr(value.d, 1),
    e: numberOr(value.e, 0),
    f: numberOr(value.f, 0),
  };
}

function readColor(value: unknown): RGBA | null {
  if (!isRecord(value)) return null;
  return normalizeColor({
    r: numberOr(value.r, 0),
    g: numberOr(value.g, 0),
    b: numberOr(value.b, 0),
    a: numberOr(value.a, 1),
  });
}

/**
 * Rebuilds a node from parsed JSON. Nodes that cannot be read are dropped
 * rather than producing a document that crashes when rendered, and each drop
 * is counted so the caller can say so.
 */
function readNode(value: unknown, dropped: { count: number }): SceneNode | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  const base = {
    id: stringOr(value.id, newId()),
    name: stringOr(value.name, 'Object'),
    visible: boolOr(value.visible, true),
    locked: boolOr(value.locked, false),
    opacity: Math.max(0, Math.min(1, numberOr(value.opacity, 1))),
    blendMode: readBlendMode(value.blendMode),
    transform: readMatrix(value.transform),
  };

  if (type === 'group' || type === 'layer') {
    const raw = Array.isArray(value.children) ? value.children : [];
    const children = raw.map((child) => readNode(child, dropped)).filter((n): n is SceneNode => n !== null);
    dropped.count += raw.length - children.length;
    return { ...base, type, children } as SceneNode;
  }
  if (type === 'path') {
    const path = readPath(value.path);
    if (!path) return null;
    return {
      ...base,
      type: 'path',
      path,
      fill: readFill(value.fill),
      stroke: readStroke(value.stroke),
    };
  }
  if (type === 'text') {
    return {
      ...base,
      type: 'text',
      text: stringOr(value.text, ''),
      x: numberOr(value.x, 0),
      y: numberOr(value.y, 0),
      fontFamily: stringOr(value.fontFamily, 'Segoe UI'),
      fontSize: Math.max(1, numberOr(value.fontSize, 16)),
      fontWeight: numberOr(value.fontWeight, 400),
      italic: boolOr(value.italic, false),
      letterSpacing: numberOr(value.letterSpacing, 0),
      lineHeight: Math.max(0.1, numberOr(value.lineHeight, 1.2)),
      align: value.align === 'middle' || value.align === 'end' ? value.align : 'start',
      fill: readFill(value.fill),
      stroke: readStroke(value.stroke),
    };
  }
  if (type === 'image') {
    const href = stringOr(value.href, '');
    if (href === '') return null;
    return {
      ...base,
      type: 'image',
      href,
      x: numberOr(value.x, 0),
      y: numberOr(value.y, 0),
      width: Math.max(0, numberOr(value.width, 0)),
      height: Math.max(0, numberOr(value.height, 0)),
    };
  }
  return null;
}

/** Rebuilds path geometry, dropping anything that is not usable. */
function readPath(value: unknown): PathData | null {
  if (!isRecord(value) || !Array.isArray(value.subpaths)) return null;
  const subpaths: SubPath[] = [];
  for (const raw of value.subpaths) {
    if (!isRecord(raw) || !Array.isArray(raw.anchors)) continue;
    const anchors: Anchor[] = [];
    for (const item of raw.anchors) {
      if (!isRecord(item)) continue;
      const point = readVec(item.point);
      if (!point) continue;
      anchors.push({
        point,
        inHandle: readVec(item.inHandle) ?? { x: 0, y: 0 },
        outHandle: readVec(item.outHandle) ?? { x: 0, y: 0 },
        type: item.type === 'smooth' || item.type === 'symmetric' ? item.type : 'corner',
      });
    }
    if (anchors.length > 0) subpaths.push({ anchors, closed: boolOr(raw.closed, false) });
  }
  return { subpaths };
}

function readVec(value: unknown): Vec | null {
  if (!isRecord(value)) return null;
  const x = numberOr(value.x, NaN);
  const y = numberOr(value.y, NaN);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function readPaint(value: unknown): Paint | null {
  if (!isRecord(value)) return null;
  if (value.type === 'solid') {
    const color = readColor(value.color);
    return color ? { type: 'solid', color } : null;
  }
  if (value.type === 'linear' || value.type === 'radial') {
    const stops = Array.isArray(value.stops)
      ? value.stops
          .map((stop) => {
            if (!isRecord(stop)) return null;
            const color = readColor(stop.color);
            return color ? { offset: numberOr(stop.offset, 0), color } : null;
          })
          .filter((stop): stop is GradientStop => stop !== null)
      : [];
    if (stops.length === 0) return null;
    if (value.type === 'linear') {
      return {
        type: 'linear',
        from: readVec(value.from) ?? { x: 0, y: 0 },
        to: readVec(value.to) ?? { x: 1, y: 0 },
        stops,
      };
    }
    return {
      type: 'radial',
      center: readVec(value.center) ?? { x: 0, y: 0 },
      radius: Math.max(0, numberOr(value.radius, 1)),
      focal: readVec(value.focal) ?? undefined,
      stops,
    };
  }
  return { type: 'none' };
}

function readFill(value: unknown): Fill {
  if (!isRecord(value)) return noFill();
  return {
    paint: readPaint(value.paint) ?? { type: 'none' },
    rule: value.rule === 'evenodd' ? 'evenodd' : 'nonzero',
  };
}

function readStroke(value: unknown): Stroke {
  if (!isRecord(value)) return noStroke();
  const dash = Array.isArray(value.dash)
    ? value.dash.filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0)
    : [];
  return {
    paint: readPaint(value.paint) ?? { type: 'none' },
    width: Math.max(0, numberOr(value.width, 1)),
    cap: value.cap === 'round' || value.cap === 'square' ? value.cap : 'butt',
    join: value.join === 'round' || value.join === 'bevel' ? value.join : 'miter',
    miterLimit: Math.max(1, numberOr(value.miterLimit, 4)),
    dash,
    dashOffset: numberOr(value.dashOffset, 0),
  };
}

export type ParseResult = { document: VectarDocument; warnings: string[] };

export function parseDocument(json: string): ParseResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      document: createDocument(),
      warnings: [`The file is not valid JSON: ${(error as Error).message}`],
    };
  }

  if (!isRecord(parsed) || parsed.format !== 'vectar') {
    return { document: createDocument(), warnings: ['The file is not a Vectar document.'] };
  }

  const width = numberOr(parsed.width, 1280);
  const height = numberOr(parsed.height, 800);
  const document = createDocument(width, height, stringOr(parsed.name, 'Untitled'));
  document.unit = (['px', 'mm', 'in', 'pt'] as Unit[]).includes(parsed.unit as Unit)
    ? (parsed.unit as Unit)
    : 'px';
  document.background = parsed.background === null ? null : readColor(parsed.background);

  const dropped = { count: 0 };
  const rawLayers = Array.isArray(parsed.layers) ? parsed.layers : [];
  const layers = rawLayers
    .map((layer) => readNode(layer, dropped))
    .filter((n): n is SceneNode => n !== null && n.type === 'layer');
  if (layers.length === 0) warnings.push('No layers were found; an empty layer was created.');
  else document.layers = layers as LayerNode[];
  dropped.count += rawLayers.length - layers.length;
  if (dropped.count > 0) {
    warnings.push(`${dropped.count} object(s) could not be read and were skipped.`);
  }

  if (numberOr(parsed.version, 1) > 1) {
    warnings.push('The file was written by a newer version; some features may be missing.');
  }

  return { document, warnings };
}

/** Deep copy of a whole document, used for snapshots and "revert". */
export function cloneDocument(doc: VectarDocument): VectarDocument {
  return {
    ...doc,
    background: doc.background ? { ...doc.background } : null,
    layers: doc.layers.map((layer) => cloneNode(layer, false) as LayerNode),
  };
}
