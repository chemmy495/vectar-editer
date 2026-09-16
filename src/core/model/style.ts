import type { Vec } from '../geometry/vec.ts';
import { BLACK, type RGBA } from './color.ts';

export type GradientStop = { offset: number; color: RGBA };

export type Paint =
  | { type: 'none' }
  | { type: 'solid'; color: RGBA }
  | { type: 'linear'; from: Vec; to: Vec; stops: GradientStop[] }
  | { type: 'radial'; center: Vec; radius: number; focal?: Vec; stops: GradientStop[] };

export type FillRule = 'nonzero' | 'evenodd';
export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export type Fill = { paint: Paint; rule: FillRule };

export type Stroke = {
  paint: Paint;
  width: number;
  cap: LineCap;
  join: LineJoin;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
};

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export const NO_PAINT: Paint = { type: 'none' };

export const solidPaint = (color: RGBA): Paint => ({ type: 'solid', color: { ...color } });

export const defaultFill = (color: RGBA = BLACK): Fill => ({ paint: solidPaint(color), rule: 'nonzero' });

export const noFill = (): Fill => ({ paint: NO_PAINT, rule: 'nonzero' });

export const defaultStroke = (color: RGBA = BLACK, width = 1): Stroke => ({
  paint: solidPaint(color),
  width,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  dash: [],
  dashOffset: 0,
});

export const noStroke = (): Stroke => ({
  paint: NO_PAINT,
  width: 1,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  dash: [],
  dashOffset: 0,
});

export const isPaintVisible = (paint: Paint): boolean => {
  if (paint.type === 'none') return false;
  if (paint.type === 'solid') return paint.color.a > 0;
  return paint.stops.length > 0;
};

export const isFillVisible = (fill: Fill): boolean => isPaintVisible(fill.paint);

export const isStrokeVisible = (stroke: Stroke): boolean =>
  isPaintVisible(stroke.paint) && stroke.width > 0;

/** The single representative colour of a paint, used for swatches. */
export function paintColor(paint: Paint): RGBA | null {
  if (paint.type === 'solid') return paint.color;
  if (paint.type === 'linear' || paint.type === 'radial') return paint.stops[0]?.color ?? null;
  return null;
}

export function clonePaint(paint: Paint): Paint {
  switch (paint.type) {
    case 'none':
      return { type: 'none' };
    case 'solid':
      return { type: 'solid', color: { ...paint.color } };
    case 'linear':
      return {
        type: 'linear',
        from: { ...paint.from },
        to: { ...paint.to },
        stops: paint.stops.map((s) => ({ offset: s.offset, color: { ...s.color } })),
      };
    case 'radial':
      return {
        type: 'radial',
        center: { ...paint.center },
        radius: paint.radius,
        focal: paint.focal ? { ...paint.focal } : undefined,
        stops: paint.stops.map((s) => ({ offset: s.offset, color: { ...s.color } })),
      };
  }
}

export const cloneFill = (fill: Fill): Fill => ({ paint: clonePaint(fill.paint), rule: fill.rule });

export const cloneStroke = (stroke: Stroke): Stroke => ({
  paint: clonePaint(stroke.paint),
  width: stroke.width,
  cap: stroke.cap,
  join: stroke.join,
  miterLimit: stroke.miterLimit,
  dash: [...stroke.dash],
  dashOffset: stroke.dashOffset,
});
