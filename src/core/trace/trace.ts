import type { Vec } from '../geometry/vec.ts';
import { scaling } from '../geometry/matrix.ts';
import type { Cubic } from '../geometry/bezier.ts';
import { pathFromCubicLoops } from '../path/build.ts';
import { anchor, type PathData, type SubPath } from '../path/path.ts';
import type { RGBA } from '../model/color.ts';
import { createPathNode, type PathNode } from '../model/node.ts';
import { defaultFill, noStroke } from '../model/style.ts';
import { labelComponents, maskFor, traceLoops, type Loop } from './contour.ts';
import { fitClosedLoop } from './fit.ts';
import { blur, quantize, type ImageData8 } from './quantize.ts';
import { collapseCollinear, dedupe, findCorners, simplifyLoop, smoothLoop } from './simplify.ts';

export type TraceOptions = {
  /** Upper bound on the number of colours in the traced result. */
  maxColors: number;
  /** Box-blur passes applied before quantization, to tame compression noise. */
  blurPasses: number;
  /** Pixels with alpha below this are treated as empty. */
  alphaThreshold: number;
  /** Regions smaller than this many pixels are discarded as speckle. */
  minArea: number;
  /** Ramer-Douglas-Peucker tolerance in pixels. */
  simplifyTolerance: number;
  /** Maximum distance between the fitted curve and the traced outline. */
  fitTolerance: number;
  /** Turns sharper than this stay as hard corners. */
  cornerThresholdDeg: number;
  /** When false the outlines stay as polygons instead of bezier curves. */
  curves: boolean;
  /** Vertex-averaging passes that soften pixel staircases before fitting. */
  smoothPasses: number;
  /** Drops the dominant colour along the image border. */
  ignoreBackground: boolean;
  /** Document units per source pixel. */
  scale: number;
  /** Groups every traced shape under one node per colour. */
  onProgress?: (fraction: number, message: string) => void;
};

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  maxColors: 16,
  blurPasses: 0,
  alphaThreshold: 128,
  minArea: 8,
  simplifyTolerance: 1,
  fitTolerance: 1.2,
  cornerThresholdDeg: 75,
  curves: true,
  smoothPasses: 1,
  ignoreBackground: false,
  scale: 1,
};

/** Presets exposed in the import dialog. */
export const TRACE_PRESETS: Record<string, Partial<TraceOptions>> = {
  'Photo (detailed)': { maxColors: 32, blurPasses: 1, minArea: 6, simplifyTolerance: 0.8, fitTolerance: 1, smoothPasses: 1 },
  'Photo (fast)': { maxColors: 12, blurPasses: 1, minArea: 24, simplifyTolerance: 1.6, fitTolerance: 2, smoothPasses: 1 },
  'Logo / flat art': { maxColors: 8, blurPasses: 0, minArea: 4, simplifyTolerance: 0.6, fitTolerance: 0.8, smoothPasses: 1 },
  'Line art (B/W)': { maxColors: 2, blurPasses: 0, minArea: 4, simplifyTolerance: 0.7, fitTolerance: 1, smoothPasses: 1 },
  'Pixel art (exact)': { maxColors: 32, blurPasses: 0, minArea: 1, simplifyTolerance: 0, fitTolerance: 0, curves: false, smoothPasses: 0 },
};

export type TraceResult = {
  nodes: PathNode[];
  palette: RGBA[];
  /** Regions kept after the minimum-area filter. */
  shapeCount: number;
  anchorCount: number;
  elapsedMs: number;
};

/** The palette index that dominates the image border, or -1 if ambiguous. */
function borderIndex(indices: Int32Array, width: number, height: number, paletteSize: number): number {
  const counts = new Int32Array(paletteSize);
  let total = 0;
  const sample = (x: number, y: number) => {
    const value = indices[y * width + x];
    if (value >= 0) {
      counts[value] += 1;
      total += 1;
    }
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    sample(0, y);
    sample(width - 1, y);
  }
  if (total === 0) return -1;
  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > bestCount) {
      bestCount = counts[i];
      best = i;
    }
  }
  // Only treat it as background when it clearly dominates the border.
  return bestCount / total >= 0.6 ? best : -1;
}

/** Converts one traced loop into a subpath, simplified and optionally curved. */
function loopToSubPath(loop: Loop, options: TraceOptions): SubPath | null {
  let points: Vec[] = dedupe(loop.points);
  if (points.length < 3) return null;

  if (options.smoothPasses > 0) points = smoothLoop(points, 0.5, options.smoothPasses);
  if (options.simplifyTolerance > 0) points = simplifyLoop(points, options.simplifyTolerance);
  else if (options.smoothPasses === 0) points = collapseCollinear(points);
  points = dedupe(points);
  if (points.length < 3) return null;

  if (!options.curves || options.fitTolerance <= 0) {
    return { anchors: points.map((p) => anchor(p)), closed: true };
  }

  const corners = findCorners(points, (options.cornerThresholdDeg * Math.PI) / 180);
  const cubics: Cubic[] = fitClosedLoop(points, options.fitTolerance, corners);
  if (cubics.length === 0) {
    return { anchors: points.map((p) => anchor(p)), closed: true };
  }
  const path = pathFromCubicLoops([cubics]);
  return path.subpaths[0] ?? null;
}

/**
 * Traces a raster image into filled vector shapes: quantize into a small
 * palette, extract each colour's regions as outlines, then simplify and fit
 * bezier curves to those outlines.
 */
export function traceImage(image: ImageData8, overrides: Partial<TraceOptions> = {}): TraceResult {
  const started = Date.now();
  const options: TraceOptions = { ...DEFAULT_TRACE_OPTIONS, ...overrides };
  const report = options.onProgress ?? (() => {});
  const { width, height } = image;

  report(0.05, 'Preparing image');
  const source = options.blurPasses > 0 ? blur(image, options.blurPasses) : image;

  report(0.15, 'Reducing colours');
  const { palette, indices } = quantize(source, options.maxColors, {
    alphaThreshold: options.alphaThreshold,
  });
  if (palette.length === 0) {
    return { nodes: [], palette, shapeCount: 0, anchorCount: 0, elapsedMs: Date.now() - started };
  }

  const skipIndex = options.ignoreBackground ? borderIndex(indices, width, height, palette.length) : -1;

  type Shape = { color: RGBA; path: PathData; area: number };
  const shapes: Shape[] = [];

  for (let colorIndex = 0; colorIndex < palette.length; colorIndex++) {
    report(0.2 + (0.7 * colorIndex) / palette.length, `Tracing colour ${colorIndex + 1} of ${palette.length}`);
    if (colorIndex === skipIndex) continue;

    const mask = maskFor(indices, colorIndex);
    const { labels, count, areas } = labelComponents(mask, width, height);
    if (count === 0) continue;

    const loops = traceLoops(mask, width, height, labels);
    const byComponent = new Map<number, Loop[]>();
    for (const loop of loops) {
      const bucket = byComponent.get(loop.component);
      if (bucket) bucket.push(loop);
      else byComponent.set(loop.component, [loop]);
    }

    for (const [component, componentLoops] of byComponent) {
      const area = areas[component] ?? 0;
      if (area < options.minArea) continue;
      // Largest loop first so the outline precedes its holes.
      componentLoops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

      const subpaths: SubPath[] = [];
      for (const loop of componentLoops) {
        if (Math.abs(loop.area) < options.minArea && subpaths.length > 0) continue;
        const subpath = loopToSubPath(loop, options);
        if (subpath) subpaths.push(subpath);
      }
      if (subpaths.length === 0) continue;
      shapes.push({ color: palette[colorIndex], path: { subpaths }, area });
    }
  }

  report(0.95, 'Building shapes');
  // Larger regions go behind smaller ones, which reproduces the original
  // layering for photographs and logos alike.
  shapes.sort((a, b) => b.area - a.area);

  let anchorCount = 0;
  const nodes = shapes.map((shape, index) => {
    const node = createPathNode(shape.path, `Trace ${index + 1}`);
    node.fill = defaultFill(shape.color);
    node.fill.rule = 'nonzero';
    node.stroke = noStroke();
    if (options.scale !== 1) node.transform = scaling(options.scale);
    for (const sp of shape.path.subpaths) anchorCount += sp.anchors.length;
    return node;
  });

  report(1, 'Done');
  return {
    nodes,
    palette,
    shapeCount: nodes.length,
    anchorCount,
    elapsedMs: Date.now() - started,
  };
}
