import { isIdentity, toSvgString } from '../../geometry/matrix.ts';
import { serializePathData, num } from '../../path/serialize.ts';
import { toCss, toHex } from '../../model/color.ts';
import { documentPixelSize, type VectarDocument } from '../../model/document.ts';
import { isContainer, type SceneNode, type TextNode } from '../../model/node.ts';
import { isStrokeVisible, type Fill, type Paint, type Stroke } from '../../model/style.ts';
import { element, escapeXml } from '../xml.ts';

export type SvgExportOptions = {
  /** Decimal places kept for coordinates. */
  precision?: number;
  /** Emit newlines and indentation. */
  pretty?: boolean;
  /** Include a solid background rectangle for the document background. */
  includeBackground?: boolean;
  /** Restrict the output to these node ids and their descendants. */
  only?: ReadonlySet<string>;
};

type GradientRegistry = {
  definitions: string[];
  idFor: (paint: Paint) => string;
};

function createGradientRegistry(precision: number): GradientRegistry {
  const definitions: string[] = [];
  const cache = new Map<string, string>();
  let counter = 0;

  const stopsMarkup = (stops: ReadonlyArray<{ offset: number; color: { a: number } }>, colors: string[]): string =>
    stops
      .map((stop, i) =>
        element('stop', {
          offset: num(stop.offset, 4),
          'stop-color': colors[i],
          'stop-opacity': stop.color.a < 1 ? num(stop.color.a, 4) : undefined,
        }),
      )
      .join('');

  const idFor = (paint: Paint): string => {
    const key = JSON.stringify(paint);
    const existing = cache.get(key);
    if (existing) return existing;
    const id = `grad${++counter}`;
    cache.set(key, id);

    if (paint.type === 'linear') {
      const colors = paint.stops.map((s) => toHex(s.color));
      definitions.push(
        element(
          'linearGradient',
          {
            id,
            gradientUnits: 'userSpaceOnUse',
            x1: num(paint.from.x, precision),
            y1: num(paint.from.y, precision),
            x2: num(paint.to.x, precision),
            y2: num(paint.to.y, precision),
          },
          stopsMarkup(paint.stops, colors),
        ),
      );
    } else if (paint.type === 'radial') {
      const colors = paint.stops.map((s) => toHex(s.color));
      definitions.push(
        element(
          'radialGradient',
          {
            id,
            gradientUnits: 'userSpaceOnUse',
            cx: num(paint.center.x, precision),
            cy: num(paint.center.y, precision),
            r: num(paint.radius, precision),
            fx: paint.focal ? num(paint.focal.x, precision) : undefined,
            fy: paint.focal ? num(paint.focal.y, precision) : undefined,
          },
          stopsMarkup(paint.stops, colors),
        ),
      );
    }
    return id;
  };

  return { definitions, idFor };
}

function paintValue(paint: Paint, gradients: GradientRegistry): { value: string; opacity?: number } {
  switch (paint.type) {
    case 'none':
      return { value: 'none' };
    case 'solid':
      return { value: toHex(paint.color), opacity: paint.color.a < 1 ? paint.color.a : undefined };
    case 'linear':
    case 'radial':
      return { value: `url(#${gradients.idFor(paint)})` };
  }
}

/** Presentation attributes for a node's fill and stroke. */
function styleAttributes(
  fill: Fill,
  stroke: Stroke,
  gradients: GradientRegistry,
  precision: number,
): Record<string, string | number | undefined> {
  const fillPaint = paintValue(fill.paint, gradients);
  const attributes: Record<string, string | number | undefined> = {
    fill: fillPaint.value,
    'fill-opacity': fillPaint.opacity === undefined ? undefined : num(fillPaint.opacity, 4),
    'fill-rule': fill.rule === 'evenodd' ? 'evenodd' : undefined,
  };

  if (!isStrokeVisible(stroke)) {
    if (stroke.paint.type !== 'none') attributes.stroke = 'none';
    return attributes;
  }

  const strokePaint = paintValue(stroke.paint, gradients);
  attributes.stroke = strokePaint.value;
  if (strokePaint.opacity !== undefined) attributes['stroke-opacity'] = num(strokePaint.opacity, 4);
  attributes['stroke-width'] = num(stroke.width, precision);
  if (stroke.cap !== 'butt') attributes['stroke-linecap'] = stroke.cap;
  if (stroke.join !== 'miter') attributes['stroke-linejoin'] = stroke.join;
  if (stroke.join === 'miter' && stroke.miterLimit !== 4) attributes['stroke-miterlimit'] = num(stroke.miterLimit, 2);
  if (stroke.dash.length > 0) {
    attributes['stroke-dasharray'] = stroke.dash.map((d) => num(d, precision)).join(' ');
    if (stroke.dashOffset !== 0) attributes['stroke-dashoffset'] = num(stroke.dashOffset, precision);
  }
  return attributes;
}

function commonAttributes(node: SceneNode, precision: number): Record<string, string | number | undefined> {
  return {
    id: node.id,
    'data-name': node.name,
    transform: isIdentity(node.transform) ? undefined : toSvgString(node.transform, precision),
    opacity: node.opacity < 1 ? num(node.opacity, 4) : undefined,
    display: node.visible ? undefined : 'none',
    style: node.blendMode === 'normal' ? undefined : `mix-blend-mode:${node.blendMode}`,
  };
}

function textMarkup(node: TextNode, gradients: GradientRegistry, precision: number): string {
  const lines = node.text.split('\n');
  const body = lines
    .map((line, index) =>
      element(
        'tspan',
        {
          x: num(node.x, precision),
          dy: index === 0 ? 0 : num(node.fontSize * node.lineHeight, precision),
        },
        escapeXml(line),
      ),
    )
    .join('');

  return element(
    'text',
    {
      ...commonAttributes(node, precision),
      x: num(node.x, precision),
      y: num(node.y, precision),
      'font-family': node.fontFamily,
      'font-size': num(node.fontSize, precision),
      'font-weight': node.fontWeight === 400 ? undefined : node.fontWeight,
      'font-style': node.italic ? 'italic' : undefined,
      'letter-spacing': node.letterSpacing === 0 ? undefined : num(node.letterSpacing, precision),
      'text-anchor': node.align === 'start' ? undefined : node.align,
      'xml:space': 'preserve',
      ...styleAttributes(node.fill, node.stroke, gradients, precision),
    },
    body,
  );
}

function nodeMarkup(
  node: SceneNode,
  gradients: GradientRegistry,
  options: Required<Pick<SvgExportOptions, 'precision'>> & { only?: ReadonlySet<string> },
): string {
  const { precision } = options;
  if (options.only && !options.only.has(node.id) && !isContainer(node)) return '';

  switch (node.type) {
    case 'path': {
      const d = serializePathData(node.path, precision);
      if (d === '') return '';
      return element('path', {
        ...commonAttributes(node, precision),
        d,
        ...styleAttributes(node.fill, node.stroke, gradients, precision),
      });
    }
    case 'text':
      return textMarkup(node, gradients, precision);
    case 'image':
      return element('image', {
        ...commonAttributes(node, precision),
        x: num(node.x, precision),
        y: num(node.y, precision),
        width: num(node.width, precision),
        height: num(node.height, precision),
        href: node.href,
      });
    case 'group':
    case 'layer': {
      const body = node.children.map((child) => nodeMarkup(child, gradients, options)).join('');
      if (body === '') return '';
      return element('g', commonAttributes(node, precision), body);
    }
  }
}

/** Serializes a document as a standalone SVG file. */
export function exportSvg(doc: VectarDocument, options: SvgExportOptions = {}): string {
  const precision = options.precision ?? 3;
  const pretty = options.pretty ?? true;
  const includeBackground = options.includeBackground ?? true;
  const { width, height } = documentPixelSize(doc);
  const gradients = createGradientRegistry(precision);

  const bodyParts: string[] = [];
  if (includeBackground && doc.background && doc.background.a > 0) {
    bodyParts.push(
      element('rect', {
        x: 0,
        y: 0,
        width: num(width, precision),
        height: num(height, precision),
        fill: toCss(doc.background),
      }),
    );
  }
  for (const layer of doc.layers) {
    const markup = nodeMarkup(layer, gradients, { precision, only: options.only });
    if (markup) bodyParts.push(markup);
  }

  const defs = gradients.definitions.length > 0 ? element('defs', {}, gradients.definitions.join('')) : '';
  const body = defs + bodyParts.join('');

  const open = element(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      version: '1.1',
      width: num(width, precision),
      height: num(height, precision),
      viewBox: `0 0 ${num(width, precision)} ${num(height, precision)}`,
    },
    body,
  );

  const header = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';
  if (!pretty) return `${header}${open}`;
  return `${header}\n${indentMarkup(open)}\n`;
}

/** Re-indents flat markup so the exported file is readable. */
function indentMarkup(markup: string): string {
  const tokens = markup.replace(/></g, '>\n<').split('\n');
  const lines: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
    lines.push('  '.repeat(depth) + token);
    const isSelfClosing = /\/>$/.test(token);
    const isClosing = /^<\//.test(token);
    const hasInlineClose = /^<([a-zA-Z][\w:-]*)[^>]*>.*<\/\1>$/.test(token);
    if (!isSelfClosing && !isClosing && !hasInlineClose && /^<[a-zA-Z]/.test(token)) depth += 1;
  }
  return lines.join('\n');
}
