import { createDocument, type Unit, type VectarDocument } from '../model/document.ts';
import { cloneNode, newId, type LayerNode, type SceneNode } from '../model/node.ts';
import { normalizeColor, type RGBA } from '../model/color.ts';
import { identity, type Matrix } from '../geometry/matrix.ts';

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
 * Rebuilds a node from parsed JSON. Nodes whose `type` is unknown are dropped
 * rather than producing a broken document.
 */
function readNode(value: unknown): SceneNode | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  const base = {
    id: stringOr(value.id, newId()),
    name: stringOr(value.name, 'Object'),
    visible: boolOr(value.visible, true),
    locked: boolOr(value.locked, false),
    opacity: Math.max(0, Math.min(1, numberOr(value.opacity, 1))),
    blendMode: stringOr(value.blendMode, 'normal'),
    transform: readMatrix(value.transform),
  };

  if (type === 'group' || type === 'layer') {
    const children = Array.isArray(value.children)
      ? value.children.map(readNode).filter((n): n is SceneNode => n !== null)
      : [];
    return { ...base, type, children } as SceneNode;
  }
  if (type === 'path' || type === 'text' || type === 'image') {
    // Style and geometry fields are carried through as-is; they are plain data
    // and any missing piece is filled in by the defaults below.
    return { ...value, ...base } as SceneNode;
  }
  return null;
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

  const layers = Array.isArray(parsed.layers)
    ? parsed.layers.map(readNode).filter((n): n is SceneNode => n !== null && n.type === 'layer')
    : [];
  if (layers.length === 0) warnings.push('No layers were found; an empty layer was created.');
  else document.layers = layers as LayerNode[];

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
