import { compose, identity, parseTransform, scaling, translation, type Matrix } from '../../geometry/matrix.ts';
import type { Rect } from '../../geometry/rect.ts';
import { parsePathData } from '../../path/parse.ts';
import { ellipsePath, linePath, polylinePath, rectanglePath } from '../../path/shapes.ts';
import type { PathData } from '../../path/path.ts';
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
  fill: Paint;
  fillRule: FillRule;
  fillOpacity: number;
  stroke: Paint;
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
  fill: solidPaint(BLACK),
  fillRule: 'nonzero',
  fillOpacity: 1,
  stroke: { type: 'none' },
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

/** Resolves a gradient, following `href` inheritance for stops. */
function resolveGradient(id: string, gradients: Map<string, GradientDefinition>, depth = 0): Paint {
  const definition = gradients.get(id);
  if (!definition || depth > 8) return { type: 'none' };
  let stops = definition.stops;
  if (stops.length === 0 && definition.href) {
    const inherited = resolveGradient(definition.href.replace(/^#/, ''), gradients, depth + 1);
    if (inherited.type === 'linear' || inherited.type === 'radial') stops = inherited.stops;
  }
  if (stops.length === 0) return { type: 'none' };

  const a = definition.attributes;
  if (definition.kind === 'linear') {
    return {
      type: 'linear',
      from: { x: parseLength(a.x1 ?? '0%', 100), y: parseLength(a.y1 ?? '0%', 100) },
      to: { x: parseLength(a.x2 ?? '100%', 100), y: parseLength(a.y2 ?? '0%', 100) },
      stops,
    };
  }
  return {
    type: 'radial',
    center: { x: parseLength(a.cx ?? '50%', 100), y: parseLength(a.cy ?? '50%', 100) },
    radius: parseLength(a.r ?? '50%', 100),
    stops,
  };
}

function resolvePaint(
  value: string | undefined,
  inherited: Paint,
  gradients: Map<string, GradientDefinition>,
): Paint {
  if (value === undefined) return inherited;
  const text = value.trim();
  if (text === '' || text === 'inherit') return inherited;
  if (text === 'none') return { type: 'none' };
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(text);
  if (url) {
    const paint = resolveGradient(url[1], gradients);
    if (paint.type !== 'none') return paint;
    // Fall back to any colour given after the url(), as SVG allows.
    const fallback = parseColor(text.slice(url[0].length).trim());
    return fallback ? solidPaint(fallback) : { type: 'none' };
  }
  const color = parseColor(text);
  return color ? solidPaint(color) : inherited;
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
    fill: resolvePaint(get('fill'), inherited.fill, gradients),
    fillRule: (get('fill-rule') as FillRule | undefined) === 'evenodd' ? 'evenodd' : inherited.fillRule,
    fillOpacity: numberOr(get('fill-opacity'), inherited.fillOpacity),
    stroke: resolvePaint(get('stroke'), inherited.stroke, gradients),
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

const fillFrom = (style: InheritedStyle): Fill => ({
  paint: withOpacity(style.fill, style.fillOpacity),
  rule: style.fillRule,
});

const strokeFrom = (style: InheritedStyle): Stroke => ({
  paint: withOpacity(style.stroke, style.strokeOpacity),
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
  depth: number,
): SceneNode[] {
  if (SKIPPED.has(node.name) || depth > 64) return [];
  if (node.attributes.display === 'none') return [];

  const style = resolveStyle(node, inherited, gradients);
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
    for (const child of node.children) children.push(...convertElement(child, style, gradients, depth + 1));
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
    text.fill = cloneFill(fillFrom(style));
    text.stroke = cloneStroke(strokeFrom(style));
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
  path.fill = cloneFill(fillFrom(style));
  path.stroke = cloneStroke(strokeFrom(style));
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
    // `preserveAspectRatio` beyond the uniform default is not modelled.
    const scaleX = width / viewBox.width;
    const scaleY = height / viewBox.height;
    rootTransform = compose(scaling(scaleX, scaleY), translation(-viewBox.x, -viewBox.y));
    if (root.attributes.preserveAspectRatio && root.attributes.preserveAspectRatio !== 'none') {
      const uniform = Math.min(scaleX, scaleY);
      if (Math.abs(scaleX - scaleY) > 1e-6) {
        rootTransform = compose(
          translation((width - viewBox.width * uniform) / 2, (height - viewBox.height * uniform) / 2),
          scaling(uniform),
          translation(-viewBox.x, -viewBox.y),
        );
      }
    }
  }

  const children: SceneNode[] = [];
  for (const child of root.children) children.push(...convertElement(child, ROOT_STYLE, gradients, 0));

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

