import { add, dist, len, neg, normalize, perp, scale, sub, type Vec } from '../geometry/vec.ts';
import type { Cubic } from '../geometry/bezier.ts';
import { subPathFromCubics, subPathFromPoints } from '../path/build.ts';
import type { PathData, SubPath } from '../path/path.ts';
import { fitCurve } from '../trace/fit.ts';

/** One sampled point of a freehand stroke. */
export type StrokePoint = Vec & {
  /** Stylus pressure in 0-1; mouse input reports 0.5. */
  pressure: number;
};

export type BrushOptions = {
  /** Stroke width at full pressure, in document units. */
  width: number;
  /** Width at zero pressure as a fraction of `width`. */
  minWidthRatio: number;
  /** Whether pressure varies the width at all. */
  pressureEnabled: boolean;
  /** How strongly speed thins the stroke; 0 disables it. */
  speedThinning: number;
  /** Input smoothing in 0-1. */
  smoothing: number;
  /** Maximum distance between the outline and the fitted curve. */
  fitTolerance: number;
  /** Round ends instead of flat ones. */
  roundCap: boolean;
};

export const DEFAULT_BRUSH: BrushOptions = {
  width: 8,
  minWidthRatio: 0.35,
  pressureEnabled: true,
  speedThinning: 0.35,
  smoothing: 0.5,
  fitTolerance: 0.6,
  roundCap: true,
};

/** Drops points closer together than `minDistance`, which removes jitter. */
export function resample(points: readonly StrokePoint[], minDistance = 1.2): StrokePoint[] {
  if (points.length === 0) return [];
  const result: StrokePoint[] = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    const previous = result[result.length - 1];
    if (dist(previous, points[i]) >= minDistance) result.push({ ...points[i] });
  }
  const last = points[points.length - 1];
  if (result.length === 1 || dist(result[result.length - 1], last) > 1e-6) result.push({ ...last });
  return result;
}

/** Exponential smoothing of position and pressure along the stroke. */
export function smoothStroke(points: readonly StrokePoint[], strength: number): StrokePoint[] {
  if (points.length < 3 || strength <= 0) return points.map((p) => ({ ...p }));
  const alpha = Math.min(0.95, Math.max(0, strength));
  const result = points.map((p) => ({ ...p }));
  // Two passes in opposite directions keep the stroke from lagging the input.
  for (let i = 1; i < result.length - 1; i++) {
    result[i].x += (result[i - 1].x - result[i].x) * alpha * 0.5;
    result[i].y += (result[i - 1].y - result[i].y) * alpha * 0.5;
    result[i].pressure += (result[i - 1].pressure - result[i].pressure) * alpha * 0.5;
  }
  for (let i = result.length - 2; i > 0; i--) {
    result[i].x += (result[i + 1].x - result[i].x) * alpha * 0.5;
    result[i].y += (result[i + 1].y - result[i].y) * alpha * 0.5;
    result[i].pressure += (result[i + 1].pressure - result[i].pressure) * alpha * 0.5;
  }
  return result;
}

/** Half-width at each sample, from pressure and drawing speed. */
function halfWidths(points: readonly StrokePoint[], options: BrushOptions): number[] {
  const base = options.width / 2;
  const minimum = base * Math.max(0.01, Math.min(1, options.minWidthRatio));

  const speeds: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    speeds.push(dist(previous, next) / 2);
  }
  const maxSpeed = Math.max(1e-6, ...speeds);

  return points.map((point, i) => {
    let t = options.pressureEnabled ? Math.max(0, Math.min(1, point.pressure)) : 1;
    if (options.speedThinning > 0) {
      const fast = Math.min(1, speeds[i] / maxSpeed);
      t *= 1 - options.speedThinning * fast;
    }
    return minimum + (base - minimum) * t;
  });
}

/** Unit tangent at sample `i`, using neighbours so it stays stable. */
function tangentAt(points: readonly StrokePoint[], i: number): Vec {
  const previous = points[Math.max(0, i - 1)];
  const next = points[Math.min(points.length - 1, i + 1)];
  const direction = sub(next, previous);
  if (len(direction) > 1e-9) return normalize(direction);
  if (i + 1 < points.length) return normalize(sub(points[i + 1], points[i]));
  if (i > 0) return normalize(sub(points[i], points[i - 1]));
  return { x: 1, y: 0 };
}

/**
 * Semicircular cap around `center`, running from `center + normal * radius` to
 * `center - normal * radius` and bulging along `bulge`.
 *
 * The two cap endpoints are exactly opposite each other across the centre, so
 * the arc is always half a turn; what matters is which way round it goes.
 * Deriving it from the tangent rather than from the endpoint angles is what
 * keeps the bulge outside the stroke instead of folding back into it.
 * Endpoints are not emitted, since the caller already has them.
 */
function capArc(center: Vec, normal: Vec, bulge: Vec, radius: number, steps = 8): Vec[] {
  const result: Vec[] = [];
  for (let i = 1; i < steps; i++) {
    const t = (Math.PI * i) / steps;
    const alongNormal = Math.cos(t) * radius;
    const alongBulge = Math.sin(t) * radius;
    result.push({
      x: center.x + normal.x * alongNormal + bulge.x * alongBulge,
      y: center.y + normal.y * alongNormal + bulge.y * alongBulge,
    });
  }
  return result;
}

/**
 * Builds the filled outline of a pressure-varying brush stroke: offset the
 * centreline by the half-width on each side, then join the two sides with caps.
 */
export function brushOutlinePoints(points: readonly StrokePoint[], options: BrushOptions): Vec[] {
  if (points.length === 0) return [];
  const widths = halfWidths(points, options);

  if (points.length === 1) {
    // A single tap is drawn as a dot.
    const center = points[0];
    const radius = widths[0];
    const circle: Vec[] = [];
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      circle.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
    return circle;
  }

  const left: Vec[] = [];
  const right: Vec[] = [];
  const normals: Vec[] = [];
  const tangents: Vec[] = [];
  for (let i = 0; i < points.length; i++) {
    const tangent = tangentAt(points, i);
    const normal = perp(tangent);
    tangents.push(tangent);
    normals.push(normal);
    left.push(add(points[i], scale(normal, widths[i])));
    right.push(sub(points[i], scale(normal, widths[i])));
  }

  // The outline runs up the left side, caps the far end, comes back down the
  // right side, then caps the near end.
  const outline: Vec[] = [...left];
  const lastIndex = points.length - 1;
  if (options.roundCap) {
    // At the end the bulge points forward, past the final sample.
    outline.push(...capArc(points[lastIndex], normals[lastIndex], tangents[lastIndex], widths[lastIndex]));
  }
  for (let i = lastIndex; i >= 0; i--) outline.push(right[i]);
  if (options.roundCap) {
    // At the start it points backward, and the arc begins on the right side.
    outline.push(...capArc(points[0], neg(normals[0]), neg(tangents[0]), widths[0]));
  }
  return outline;
}

/**
 * A closed path tracing a brush stroke. The outline is fitted with bezier
 * curves so the result stays editable rather than being a dense polygon.
 */
export function brushStrokeToPath(input: readonly StrokePoint[], options: BrushOptions): PathData {
  const sampled = smoothStroke(resample(input), options.smoothing);
  const outline = brushOutlinePoints(sampled, options);
  if (outline.length < 3) return { subpaths: [] };

  if (options.fitTolerance <= 0) {
    const subpath = subPathFromPoints(outline, true);
    return { subpaths: subpath ? [subpath] : [] };
  }

  // Fitting the closed outline in one run keeps the two sides and both caps in
  // a single subpath.
  const cubics: Cubic[] = fitCurve([...outline, outline[0]], options.fitTolerance);
  const subpath: SubPath | null =
    cubics.length > 0 ? subPathFromCubics(cubics, true) : subPathFromPoints(outline, true);
  return { subpaths: subpath ? [subpath] : [] };
}

/**
 * An open centreline path for the pencil tool, which draws with the regular
 * stroke style instead of a filled outline.
 */
export function pencilStrokeToPath(input: readonly StrokePoint[], smoothing = 0.5, tolerance = 1): PathData {
  const sampled = smoothStroke(resample(input), smoothing);
  if (sampled.length < 2) return { subpaths: [] };
  const cubics = fitCurve(sampled, Math.max(0.05, tolerance));
  const subpath = cubics.length > 0 ? subPathFromCubics(cubics, false) : subPathFromPoints(sampled, false);
  return { subpaths: subpath ? [subpath] : [] };
}
