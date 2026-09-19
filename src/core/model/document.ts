import { WHITE, type RGBA } from './color.ts';
import { createLayerNode, type LayerNode, type SceneNode } from './node.ts';

/** Physical unit the canvas size is expressed in. Pixels are the default. */
export type Unit = 'px' | 'mm' | 'in' | 'pt';

export type VectarDocument = {
  /** File format marker, written into `.vectar` files. */
  format: 'vectar';
  version: 1;
  name: string;
  width: number;
  height: number;
  unit: Unit;
  /** Canvas background. `null` means a transparent canvas. */
  background: RGBA | null;
  layers: LayerNode[];
};

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;

export function createDocument(
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  name = 'Untitled',
): VectarDocument {
  return {
    format: 'vectar',
    version: 1,
    name,
    width,
    height,
    unit: 'px',
    background: { ...WHITE },
    layers: [createLayerNode('Layer 1')],
  };
}

/** All top-level layers plus their descendants, in draw order. */
export function rootNodes(doc: VectarDocument): SceneNode[] {
  return doc.layers;
}

const PX_PER_UNIT: Record<Unit, number> = { px: 1, pt: 96 / 72, mm: 96 / 25.4, in: 96 };

/** Converts a length in `doc.unit` into CSS pixels. */
export const toPixels = (value: number, unit: Unit): number => value * PX_PER_UNIT[unit];

export const fromPixels = (value: number, unit: Unit): number => value / PX_PER_UNIT[unit];

export const documentPixelSize = (doc: VectarDocument): { width: number; height: number } => ({
  width: toPixels(doc.width, doc.unit),
  height: toPixels(doc.height, doc.unit),
});
