import { compose, identity, parseTransform, scaling, translation, type Matrix } from '../../geometry/matrix.ts';
import type { Rect } from '../../geometry/rect.ts';
import type { Vec } from '../../geometry/vec.ts';
import { parsePathData } from '../../path/parse.ts';
import { ellipsePath, linePath, polylinePath, rectanglePath } from '../../path/shapes.ts';
import { bounds as pathBounds, type PathData } from '../../path/path.ts';
import { BLACK, parseColor, type RGBA } from '../../model/color.ts';
import { createDocument, type VectarDocument } from '../../model/document.ts';
import {
  createGroupNode, createImageNode, createLayerNode, createPathNode, createTextNode,
  type SceneNode, type TextAlign,
} from '../../model/node.ts';
import {
  cloneFill, cloneStroke, noFill, solidPaint,
  type Fill, type FillRule, type GradientStop, type LineCap, type LineJoin, type Paint, type Stroke,
} from '../../model/style.ts';
import { findAll, parseXml, type XmlNode } from '../xml.ts';

/** Style values inherited down the SVG tree. */
type InheritedStyle = {
  fill: ResolvedPaint;
  fillRule: FillRule;
  fillOpacity: number;
  stroke: ResolvedPaint;
  strokeOpacity: number;
  strokeWidth: number;
  cap: LineCap;
  join: LineJoin;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
  textAnchor: TextAlign;
};

const ROOT_STYLE: InheritedStyle = {
  fill: { paint: solidPaint(BLACK), objectBox: false },
  fillRule: 'nonzero',
  fillOpacity: 1,
  stroke: { paint: { type: 'none' }, objectBox: false },
  strokeOpacity: 1,
  strokeWidth: 1,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  dash: [],
  dashOffset: 0,
  fontFamily: 'Segoe UI',
  fontSize: 16,
  fontWeight: 400,
  italic: false,
  letterSpacing: 0,
  textAnchor: 'start',
};

const UNITS: Record<string, number> = {
  '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96,
};

/** Parses an SVG length. Percentages resolve against `reference`. */
export function parseLength(input: string | undefined, reference = 0): number {
  if (input === undefined) return 0;
  const text = input.trim();
  if (text === '') return 0;
  if (text.endsWith('%')) {
    const value = parseFloat(text);
    return Number.isFinite(value) ? (value / 100) * reference : 0;
  }
  const match = /^([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s*([a-zA-Z]*)$/.exec(text);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  return value * (UNITS[match[2].toLowerCase()] ?? 1);
}

/** Splits an inline `style` attribute into declarations. */
function parseStyleAttribute(input: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input) return result;
  for (const declaration of input.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

type GradientDefinition = {
  kind: 'linear' | 'radial';
  attributes: Record<string, string>;
  stops: GradientStop[];
  href?: string;
};

/** Collects gradient definitions so `url(#id)` paints can be resolved. */
function collectGradients(root: XmlNode): Map<string, GradientDefinition> {
  const result = new Map<string, GradientDefinition>();
  const read = (node: XmlNode, kind: 'linear' | 'radial') => {
    const id = node.attributes.id;
    if (!id) return;
    const stops: GradientStop[] = [];
    for (const stop of findAll(node, 'stop')) {
      const style = parseStyleAttribute(stop.attributes.style);
      const colorText = style['stop-color'] ?? stop.attributes['stop-color'] ?? '#000';
      const opacityText = style['stop-opacity'] ?? stop.attributes['stop-opacity'];
      const color = parseColor(colorText) ?? { ...BLACK };
      const opacity = opacityText === undefined ? 1 : parseFloat(opacityText);
      const offsetText = stop.attributes.offset ?? '0';
      const offset = offsetText.endsWith('%') ? parseFloat(offsetText) / 100 : parseFloat(offsetText);
      stops.push({
        offset: Number.isFinite(offset) ? Math.max(0, Math.min(1, offset)) : 0,
        color: { ...color, a: color.a * (Number.isFinite(opacity) ? opacity : 1) },
      });
    }
    result.set(id, {
      kind,
      attributes: node.attributes,
      stops,
      href: node.attributes['xlink:href'] ?? node.attributes.href,
    });
  };
  for (const node of findAll(root, 'linearGradient')) read(node, 'linear');
  for (const node of findAll(root, 'radialGradient')) read(node, 'radial');
  return result;
}

/** A paint plus whether its coordinates are fractions of the shape's box. */
type ResolvedPaint = { paint: Paint; objectBox: boolean };

/**
 * Resolves a gradient, following `href` inheritance for stops.
 *
 * SVG's default `gradientUnits` is `objectBoundingBox`, where coordinates are
 * fractions of the shape being filled rather than user-space lengths. Those
 * cannot be turned into absolute coordinates until the shape's own bounds are
 * known, so they are kept as fractions here and mapped later.
 */
function resolveGradient(
  id: string,
  gradients: Map<string, GradientDefinition>,
  viewport: { width: number; height: number },
  depth = 0,
): ResolvedPaint {
  const definition = gradients.get(id);
  if (!definition || depth > 8) return { paint: { type: 'none' }, objectBox: false };
  let stops = definition.stops;
  if (stops.length === 0 && definition.href) {
    const inherited = resolveGradient(definition.href.replace(/^#/, ''), gradients, viewport, depth + 1);
    if (inherited.paint.type === 'linear' || inherited.paint.type === 'radial') stops = inherited.paint.stops;
  }
  if (stops.length === 0) return { paint: { type: 'none' }, objectBox: false };

  const a = definition.attributes;
  const objectBox = (a.gradientUnits ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  // In object-box units a percentage maps onto 0..1; in user space it maps
  // onto the viewport.
  const referenceX = objectBox ? 1 : viewport.width;
  const referenceY = objectBox ? 1 : viewport.height;
  const referenceDiagonal = objectBox ? 1 : Math.hypot(viewport.width, viewport.height) / Math.SQRT2;

  if (definition.kind === 'linear') {
    return {
      objectBox,
      paint: {
        type: 'linear',
        from: { x: parseLength(a.x1 ?? '0%', referenceX), y: parseLength(a.y1 ?? '0%', referenceY) },
        to: { x: parseLength(a.x2 ?? '100%', referenceX), y: parseLength(a.y2 ?? '0%', referenceY) },
        stops,
      },
    };
  }
  return {
    objectBox,
    paint: {
      type: 'radial',
      center: { x: parseLength(a.cx ?? '50%', referenceX), y: parseLength(a.cy ?? '50%', referenceY) },
      radius: parseLength(a.r ?? '50%', referenceDiagonal),
      stops,
    },
  };
}

/** Rewrites an object-box gradient's fractions into the shape's own bounds. */
function mapPaintToBounds(paint: Paint, bounds: Rect | null): Paint {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return paint;
  const toBox = (p: Vec): Vec => ({ x: bounds.x + p.x * bounds.width, y: bounds.y + p.y * bounds.height });
  if (paint.type === 'linear') {
    return { ...paint, from: toBox(paint.from), to: toBox(paint.to) };
  }
  if (paint.type === 'radial') {
    return {
      ...paint,
      center: toBox(paint.center),
      focal: paint.focal ? toBox(paint.focal) : undefined,
      // A single radius cannot describe a non-square box; use the mean extent.
      radius: paint.radius * ((bounds.width + bounds.height) / 2),
    };
  }
  return paint;
}

function resolvePaint(
  value: string | undefined,
  inherited: ResolvedPaint,
  gradients: Map<string, GradientDefinition>,
  viewport: { width: number; height: number },
): ResolvedPaint {
  if (value === undefined) return inherited;
  const text = value.trim();
  // Keywords are case-insensitive, but the id inside url(#...) is not, so only
  // the keyword comparison is lowercased.
  const keyword = text.toLowerCase();
  if (keyword === '' || keyword === 'inherit') return inherited;
  if (keyword === 'none') return { paint: { type: 'none' }, objectBox: false };
  // There is no CSS `color` to inherit from here. Icon sets lean on
  // `currentColor` heavily, so resolving it to black keeps them visible
  // instead of importing as nothing.
  if (keyword === 'currentcolor') return { paint: solidPaint(BLACK), objectBox: false };
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(text);
  if (url) {
    const resolved = resolveGradient(url[1], gradients, viewport);
    if (resolved.paint.type !== 'none') return resolved;
    // Fall back to any colour given after the url(), as SVG allows.
    const fallback = parseColor(text.slice(url[0].length).trim());
    return { paint: fallback ? solidPaint(fallback) : { type: 'none' }, objectBox: false };
  }
  const color = parseColor(text);
  return color ? { paint: solidPaint(color), objectBox: false } : inherited;
}

/** Applies an opacity multiplier to a paint's colours. */
function withOpacity(paint: Paint, opacity: number): Paint {
  if (opacity >= 1) return paint;
  const apply = (c: RGBA): RGBA => ({ ...c, a: c.a * opacity });
  switch (paint.type) {
    case 'none':
      return paint;
    case 'solid':
      return { type: 'solid', color: apply(paint.color) };
    case 'linear':
      return { ...paint, stops: paint.stops.map((s) => ({ offset: s.offset, color: apply(s.color) })) };
    case 'radial':
      return { ...paint, stops: paint.stops.map((s) => ({ offset: s.offset, color: apply(s.color) })) };
  }
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Merges presentation attributes and inline styles into the inherited style. */
function resolveStyle(
  node: XmlNode,
  inherited: InheritedStyle,
  gradients: Map<string, GradientDefinition>,
  viewport: { width: number; height: number },
): InheritedStyle {
  const inline = parseStyleAttribute(node.attributes.style);
  const get = (name: string): string | undefined => inline[name] ?? node.attributes[name];

  const fontStyle = get('font-style');
  const weightText = get('font-weight');
  const weight =
    weightText === 'bold' ? 700
    : weightText === 'normal' ? 400
    : weightText === undefined ? inherited.fontWeight
    : numberOr(weightText, inherited.fontWeight);

  const anchor = get('text-anchor');
  const dashText = get('stroke-dasharray');
  const dash =
    dashText === undefined || dashText === 'none'
      ? inherited.dash
      : dashText.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0);

  return {
    fill: resolvePaint(get('fill'), inherited.fill, gradients, viewport),
    fillRule: (get('fill-rule') as FillRule | undefined) === 'evenodd' ? 'evenodd' : inherited.fillRule,
    fillOpacity: numberOr(get('fill-opacity'), inherited.fillOpacity),
    stroke: resolvePaint(get('stroke'), inherited.stroke, gradients, viewport),
    strokeOpacity: numberOr(get('stroke-opacity'), inherited.strokeOpacity),
    strokeWidth: get('stroke-width') === undefined ? inherited.strokeWidth : parseLength(get('stroke-width')),
    cap: (get('stroke-linecap') as LineCap | undefined) ?? inherited.cap,
    join: (get('stroke-linejoin') as LineJoin | undefined) ?? inherited.join,
    miterLimit: numberOr(get('stroke-miterlimit'), inherited.miterLimit),
    dash,
    dashOffset: numberOr(get('stroke-dashoffset'), inherited.dashOffset),
    fontFamily: (get('font-family') ?? inherited.fontFamily).split(',')[0].trim().replace(/^['"]|['"]$/g, ''),
    fontSize: get('font-size') === undefined ? inherited.fontSize : parseLength(get('font-size'), inherited.fontSize),
    fontWeight: weight,
    italic: fontStyle === undefined ? inherited.italic : fontStyle === 'italic' || fontStyle === 'oblique',
    letterSpacing: get('letter-spacing') === undefined ? inherited.letterSpacing : parseLength(get('letter-spacing')),
    textAnchor:
      anchor === 'middle' ? 'middle' : anchor === 'end' ? 'end' : anchor === 'start' ? 'start' : inherited.textAnchor,
  };
}

const fillFrom = (style: InheritedStyle, bounds: Rect | null = null): Fill => ({
  paint: withOpacity(
    style.fill.objectBox ? mapPaintToBounds(style.fill.paint, bounds) : style.fill.paint,
    style.fillOpacity,
  ),
  rule: style.fillRule,
});

const strokeFrom = (style: InheritedStyle, bounds: Rect | null = null): Stroke => ({
  paint: withOpacity(
    style.stroke.objectBox ? mapPaintToBounds(style.stroke.paint, bounds) : style.stroke.paint,
    style.strokeOpacity,
  ),
  width: style.strokeWidth,
  cap: style.cap,
  join: style.join,
  miterLimit: style.miterLimit,
  dash: style.dash,
  dashOffset: style.dashOffset,
});

/** Builds path geometry for the basic SVG shape elements. */
function shapeGeometry(node: XmlNode): PathData | null {
  const a = node.attributes;
  switch (node.name) {
    case 'path':
      return a.d ? parsePathData(a.d) : null;
    case 'rect': {
      const box: Rect = {
        x: parseLength(a.x),
        y: parseLength(a.y),
        width: parseLength(a.width),
        height: parseLength(a.height),
      };
      if (box.width <= 0 || box.height <= 0) return null;
      const rx = a.rx !== undefined ? parseLength(a.rx) : a.ry !== undefined ? parseLength(a.ry) : 0;
      return rectanglePath(box, rx);
    }
    case 'circle': {
      const r = parseLength(a.r);
      if (r <= 0) return null;
      const cx = parseLength(a.cx);
      const cy = parseLength(a.cy);
      return ellipsePath({ x: cx - r, y: cy - r, width: r * 2, height: r * 2 });
    }
    case 'ellipse': {
      const rx = parseLength(a.rx);
      const ry = parseLength(a.ry);
      if (rx <= 0 || ry <= 0) return null;
      const cx = parseLength(a.cx);
      const cy = parseLength(a.cy);
      return ellipsePath({ x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 });
    }
    case 'line':
      return linePath(
        { x: parseLength(a.x1), y: parseLength(a.y1) },
        { x: parseLength(a.x2), y: parseLength(a.y2) },
      );
    case 'polyline':
    case 'polygon': {
      const numbers = (a.points ?? '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      const points = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] });
      if (points.length < 2) return null;
      return polylinePath(points, node.name === 'polygon');
    }
    default:
      return null;
  }
}

const SKIPPED = new Set(['defs', 'linearGradient', 'radialGradient', 'title', 'desc', 'metadata', 'style', 'symbol', 'clipPath', 'mask', 'filter', 'marker', 'pattern']);

/** Converts one SVG element (and its children) into scene nodes. */
function convertElement(
  node: XmlNode,
  inherited: InheritedStyle,
  gradients: Map<string, GradientDefinition>,
  viewport: { width: number; height: number },
  depth: number,
): SceneNode[] {
  if (SKIPPED.has(node.name) || depth > 64) return [];
  if (node.attributes.display === 'none') return [];

  const style = resolveStyle(node, inherited, gradients, viewport);
  const transform = parseTransform(node.attributes.transform ?? '');
  const opacity = numberOr(node.attributes.opacity ?? parseStyleAttribute(node.attributes.style).opacity, 1);
  // `data-name` is what this editor writes; the others cover other tools.
  const label = node.attributes['data-name'] ?? node.attributes['inkscape:label'] ?? node.attributes.id;

  const finish = (scene: SceneNode): SceneNode[] => {
    scene.transform = transform;
    scene.opacity = Math.max(0, Math.min(1, opacity));
    if (label) scene.name = label;
    if (node.attributes.visibility === 'hidden') scene.visible = false;
    return [scene];
  };

  if (node.name === 'g' || node.name === 'svg' || node.name === 'a') {
    const children: SceneNode[] = [];
    for (const child of node.children) children.push(...convertElement(child, style, gradients, viewport, depth + 1));
    if (children.length === 0) return [];
    // A group that only wraps one child and adds nothing is noise; inline it.
    return finish(createGroupNode(children, label ?? 'Group'));
  }

  if (node.name === 'use') {
    // `use` is resolved as an empty group: referencing defs is out of scope.
    return [];
  }

  if (node.name === 'text' || node.name === 'tspan') {
    const pieces = [node.text, ...findAll(node, 'tspan').map((t) => t.text)];
    const content = pieces.join('').replace(/\s+/g, ' ').trim();
    if (content === '') return [];
    const text = createTextNode(content, parseLength(node.attributes.x), parseLength(node.attributes.y), label ?? content.slice(0, 24));
    text.fontFamily = style.fontFamily;
    text.fontSize = style.fontSize;
    text.fontWeight = style.fontWeight;
    text.italic = style.italic;
    text.letterSpacing = style.letterSpacing;
    text.align = style.textAnchor;
    const textBounds = { x: text.x, y: text.y - text.fontSize, width: text.fontSize * content.length * 0.55, height: text.fontSize * 1.2 };
    text.fill = cloneFill(fillFrom(style, textBounds));
    text.stroke = cloneStroke(strokeFrom(style, textBounds));
    return finish(text);
  }

  if (node.name === 'image') {
    const href = node.attributes['xlink:href'] ?? node.attributes.href;
    if (!href) return [];
    const image = createImageNode(href, parseLength(node.attributes.width), parseLength(node.attributes.height), label ?? 'Image');
    image.x = parseLength(node.attributes.x);
    image.y = parseLength(node.attributes.y);
    return finish(image);
  }

  const geometry = shapeGeometry(node);
  if (!geometry || geometry.subpaths.length === 0) return [];
  const path = createPathNode(geometry, label ?? node.name);
  const bounds = geometryBounds(geometry);
  path.fill = cloneFill(fillFrom(style, bounds));
  path.stroke = cloneStroke(strokeFrom(style, bounds));
  // An open shape with no explicit fill reads better unfilled.
  if (node.name === 'line' || node.name === 'polyline') {
    if (node.attributes.fill === undefined && !parseStyleAttribute(node.attributes.style).fill) {
      path.fill = noFill();
      if (path.stroke.paint.type === 'none') path.stroke = { ...defaultStrokeFrom(style) };
    }
  }
  return finish(path);
}

function defaultStrokeFrom(style: InheritedStyle): Stroke {
  return { ...strokeFrom(style), paint: solidPaint(BLACK) };
}

/** Bounds of freshly built geometry, used to place object-box gradients. */
function geometryBounds(path: PathData): Rect | null {
  return pathBounds(path);
}

export type SvgImportResult = {
  document: VectarDocument;
  /** Warnings about features that were skipped. */
  warnings: string[];
};

/**
 * Parses an SVG file into a document. The canvas size comes from `width`/
 * `height`, falling back to the `viewBox`, and a viewBox that does not match
 * the canvas size is applied as a transform on the imported content.
 */
export function importSvg(source: string, name = 'Imported'): SvgImportResult {
  const warnings: string[] = [];
  const root = parseXml(source);
  if (!root || root.name !== 'svg') {
    return { document: createDocument(), warnings: ['The file does not contain an <svg> root element.'] };
  }

  const viewBoxNumbers = (root.attributes.viewBox ?? '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const viewBox = viewBoxNumbers.length === 4
    ? { x: viewBoxNumbers[0], y: viewBoxNumbers[1], width: viewBoxNumbers[2], height: viewBoxNumbers[3] }
    : null;

  const declaredWidth = parseLength(root.attributes.width, viewBox?.width ?? 0);
  const declaredHeight = parseLength(root.attributes.height, viewBox?.height ?? 0);
  const width = declaredWidth > 0 ? declaredWidth : (viewBox?.width ?? 1280);
  const height = declaredHeight > 0 ? declaredHeight : (viewBox?.height ?? 800);

  const document = createDocument(width, height, name);
  const gradients = collectGradients(root);

  let rootTransform: Matrix = identity();
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    const scaleX = width / viewBox.width;
    const scaleY = height / viewBox.height;
    // The default is `xMidYMid meet`: scale uniformly and centre. Only an
    // explicit `none` stretches the artwork to fill the viewport.
    const preserve = (root.attributes.preserveAspectRatio ?? '').trim();
    if (preserve.startsWith('none')) {
      rootTransform = compose(scaling(scaleX, scaleY), translation(-viewBox.x, -viewBox.y));
    } else {
      // `slice` fills the viewport and crops; `meet` (the default) fits inside.
      const uniform = preserve.endsWith('slice') ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
      const alignX = preserve.includes('xMin') ? 0 : preserve.includes('xMax') ? 1 : 0.5;
      const alignY = preserve.includes('YMin') ? 0 : preserve.includes('YMax') ? 1 : 0.5;
      rootTransform = compose(
        translation((width - viewBox.width * uniform) * alignX, (height - viewBox.height * uniform) * alignY),
        scaling(uniform),
        translation(-viewBox.x, -viewBox.y),
      );
    }
  }

  // Presentation attributes on <svg> itself are inherited by its children.
  // Icon sets in particular put `fill="none" stroke="currentColor"` there.
  const viewport = { width: viewBox?.width ?? width, height: viewBox?.height ?? height };
  const rootStyle = resolveStyle(root, ROOT_STYLE, gradients, viewport);

  const children: SceneNode[] = [];
  for (const child of root.children) children.push(...convertElement(child, rootStyle, gradients, viewport, 0));

  const layer = createLayerNode(name);
  layer.transform = rootTransform;
  layer.children = children;
  document.layers = [layer];

  if (findAll(root, 'use').length > 0) warnings.push('<use> references were skipped.');
  if (findAll(root, 'clipPath').length > 0) warnings.push('Clip paths were skipped.');
  if (findAll(root, 'filter').length > 0) warnings.push('Filters were skipped.');
  if (findAll(root, 'pattern').length > 0) warnings.push('Pattern fills were skipped.');
  if (children.length === 0) warnings.push('No drawable content was found.');

  return { document, warnings };
}

