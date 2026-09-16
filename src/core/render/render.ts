import { compose, identity, type Matrix } from '../geometry/matrix.ts';
import { add } from '../geometry/vec.ts';
import { documentPixelSize, type VectarDocument } from '../model/document.ts';
import { toCss } from '../model/color.ts';
import { isContainer, type SceneNode, type TextNode } from '../model/node.ts';
import { isFillVisible, isStrokeVisible, type Paint } from '../model/style.ts';
import { segmentCount, type PathData } from '../path/path.ts';

/**
 * The slice of `CanvasRenderingContext2D` the renderer uses. Typing it
 * structurally keeps this module usable with an offscreen canvas or a
 * test double.
 */
export type RenderContext = {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  rect(x: number, y: number, width: number, height: number): void;
  fill(rule?: CanvasFillRule): void;
  stroke(): void;
  clip(rule?: CanvasFillRule): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
  drawImage(image: CanvasImageSource, x: number, y: number, width: number, height: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  miterLimit: number;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  letterSpacing?: string;
  setLineDash(segments: number[]): void;
  lineDashOffset: number;
};

export type RenderOptions = {
  /** Maps document coordinates to device pixels. */
  viewTransform?: Matrix;
  /** Paint the document background before the content. */
  drawBackground?: boolean;
  /** Resolves an image node's `href` to something drawable. */
  resolveImage?: (href: string) => CanvasImageSource | null;
  /** Skip these node ids, e.g. a node currently being dragged. */
  skip?: ReadonlySet<string>;
};

/** Adds a path's geometry to the current context path. */
export function tracePath(ctx: RenderContext, path: PathData): void {
  for (const subpath of path.subpaths) {
    if (subpath.anchors.length === 0) continue;
    const start = subpath.anchors[0].point;
    ctx.moveTo(start.x, start.y);
    const count = segmentCount(subpath);
    for (let i = 0; i < count; i++) {
      const from = subpath.anchors[i];
      const to = subpath.anchors[(i + 1) % subpath.anchors.length];
      const straight =
        from.outHandle.x === 0 && from.outHandle.y === 0 && to.inHandle.x === 0 && to.inHandle.y === 0;
      if (straight) {
        ctx.lineTo(to.point.x, to.point.y);
      } else {
        const c1 = add(from.point, from.outHandle);
        const c2 = add(to.point, to.inHandle);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.point.x, to.point.y);
      }
    }
    if (subpath.closed) ctx.closePath();
  }
}

/** Builds the canvas paint for a fill or stroke. */
function toCanvasStyle(ctx: RenderContext, paint: Paint): string | CanvasGradient {
  switch (paint.type) {
    case 'none':
      return 'transparent';
    case 'solid':
      return toCss(paint.color);
    case 'linear': {
      const gradient = ctx.createLinearGradient(paint.from.x, paint.from.y, paint.to.x, paint.to.y);
      for (const stop of paint.stops) gradient.addColorStop(Math.max(0, Math.min(1, stop.offset)), toCss(stop.color));
      return gradient;
    }
    case 'radial': {
      const focal = paint.focal ?? paint.center;
      const gradient = ctx.createRadialGradient(focal.x, focal.y, 0, paint.center.x, paint.center.y, Math.max(1e-6, paint.radius));
      for (const stop of paint.stops) gradient.addColorStop(Math.max(0, Math.min(1, stop.offset)), toCss(stop.color));
      return gradient;
    }
  }
}

/** The CSS `font` shorthand for a text node. */
export function fontString(node: TextNode): string {
  const style = node.italic ? 'italic ' : '';
  const family = /\s/.test(node.fontFamily) ? `"${node.fontFamily}"` : node.fontFamily;
  return `${style}${node.fontWeight} ${node.fontSize}px ${family}, sans-serif`;
}

function drawText(ctx: RenderContext, node: TextNode): void {
  ctx.font = fontString(node);
  ctx.textAlign = node.align === 'middle' ? 'center' : node.align === 'end' ? 'right' : 'left';
  ctx.textBaseline = 'alphabetic';
  if (node.letterSpacing !== 0 && 'letterSpacing' in ctx) ctx.letterSpacing = `${node.letterSpacing}px`;

  const lines = node.text.split('\n');
  lines.forEach((line, index) => {
    const y = node.y + index * node.fontSize * node.lineHeight;
    if (isFillVisible(node.fill)) {
      ctx.fillStyle = toCanvasStyle(ctx, node.fill.paint);
      ctx.fillText(line, node.x, y);
    }
    if (isStrokeVisible(node.stroke)) {
      ctx.strokeStyle = toCanvasStyle(ctx, node.stroke.paint);
      ctx.lineWidth = node.stroke.width;
      ctx.strokeText(line, node.x, y);
    }
  });
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

function drawNode(ctx: RenderContext, node: SceneNode, parent: Matrix, options: RenderOptions): void {
  if (!node.visible || node.opacity <= 0) return;
  if (options.skip?.has(node.id)) return;

  const world = compose(parent, node.transform);

  if (isContainer(node)) {
    // Group opacity and blending apply to the composite, so they are set once
    // here rather than on each child.
    const needsLayer = node.opacity < 1 || node.blendMode !== 'normal';
    if (needsLayer) {
      ctx.save();
      ctx.globalAlpha *= node.opacity;
      if (node.blendMode !== 'normal') ctx.globalCompositeOperation = node.blendMode as GlobalCompositeOperation;
    }
    for (const child of node.children) drawNode(ctx, child, world, options);
    if (needsLayer) ctx.restore();
    return;
  }

  ctx.save();
  ctx.globalAlpha *= node.opacity;
  if (node.blendMode !== 'normal') ctx.globalCompositeOperation = node.blendMode as GlobalCompositeOperation;
  ctx.transform(world.a, world.b, world.c, world.d, world.e, world.f);

  if (node.type === 'path') {
    const hasFill = isFillVisible(node.fill);
    const hasStroke = isStrokeVisible(node.stroke);
    if (hasFill || hasStroke) {
      ctx.beginPath();
      tracePath(ctx, node.path);
      if (hasFill) {
        ctx.fillStyle = toCanvasStyle(ctx, node.fill.paint);
        ctx.fill(node.fill.rule === 'evenodd' ? 'evenodd' : 'nonzero');
      }
      if (hasStroke) {
        ctx.strokeStyle = toCanvasStyle(ctx, node.stroke.paint);
        ctx.lineWidth = node.stroke.width;
        ctx.lineCap = node.stroke.cap;
        ctx.lineJoin = node.stroke.join;
        ctx.miterLimit = node.stroke.miterLimit;
        ctx.setLineDash(node.stroke.dash);
        ctx.lineDashOffset = node.stroke.dashOffset;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  } else if (node.type === 'text') {
    drawText(ctx, node);
  } else if (node.type === 'image') {
    const image = options.resolveImage?.(node.href);
    if (image) ctx.drawImage(image, node.x, node.y, node.width, node.height);
  }

  ctx.restore();
}

/** Draws a whole document. The context transform is reset before drawing. */
export function renderDocument(ctx: RenderContext, doc: VectarDocument, options: RenderOptions = {}): void {
  const view = options.viewTransform ?? identity();
  const { width, height } = documentPixelSize(doc);

  ctx.save();
  ctx.setTransform(view.a, view.b, view.c, view.d, view.e, view.f);

  if (options.drawBackground !== false && doc.background && doc.background.a > 0) {
    ctx.fillStyle = toCss(doc.background);
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.fill();
  }

  for (const layer of doc.layers) drawNode(ctx, layer, identity(), options);
  ctx.restore();
}

/** Draws a document clipped to the canvas area, as raster export needs. */
export function renderForExport(
  ctx: RenderContext,
  doc: VectarDocument,
  scale: number,
  options: RenderOptions = {},
): void {
  const { width, height } = documentPixelSize(doc);
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.restore();
  renderDocument(ctx, doc, { ...options, viewTransform: { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 } });
}
