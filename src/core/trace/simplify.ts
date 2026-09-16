import { distSq, sub, type Vec } from '../geometry/vec.ts';

/** Squared distance from `p` to the segment `a`-`b`. */
function segmentDistanceSq(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distSq(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return distSq(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Ramer-Douglas-Peucker simplification of an open polyline. Endpoints are
 * always kept.
 */
export function simplifyPolyline(points: readonly Vec[], tolerance: number): Vec[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let farthest = -1;
    let farthestDist = toleranceSq;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(points[i], points[first], points[last]);
      if (d > farthestDist) {
        farthestDist = d;
        farthest = i;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = 1;
    stack.push([first, farthest], [farthest, last]);
  }

  const result: Vec[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) result.push(points[i]);
  return result;
}

/**
 * Simplifies a closed loop. The loop is cut at two far-apart vertices so that
 * neither is dropped, then each half is simplified as an open polyline.
 */
export function simplifyLoop(points: readonly Vec[], tolerance: number): Vec[] {
  if (points.length <= 3 || tolerance <= 0) return points.slice();

  let farthest = 0;
  let farthestDist = -1;
  for (let i = 1; i < points.length; i++) {
    const d = distSq(points[0], points[i]);
    if (d > farthestDist) {
      farthestDist = d;
      farthest = i;
    }
  }

  const firstHalf = points.slice(0, farthest + 1);
  const secondHalf = [...points.slice(farthest), points[0]];
  const a = simplifyPolyline(firstHalf, tolerance);
  const b = simplifyPolyline(secondHalf, tolerance);
  // Both halves include the shared cut vertices, so drop the duplicates.
  const merged = [...a.slice(0, -1), ...b.slice(0, -1)];
  return merged.length >= 3 ? merged : points.slice();
}

/** Turn angle in radians at vertex `i` of a closed loop; 0 means straight on. */
export function turnAngle(points: readonly Vec[], index: number): number {
  const n = points.length;
  const previous = points[(index - 1 + n) % n];
  const current = points[index];
  const next = points[(index + 1) % n];
  const incoming = sub(current, previous);
  const outgoing = sub(next, current);
  const lengths = Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y);
  if (lengths === 0) return 0;
  const cos = (incoming.x * outgoing.x + incoming.y * outgoing.y) / lengths;
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

/**
 * Indices of vertices whose turn is sharper than `thresholdRadians`. These are
 * kept as hard corners when curves are fitted.
 */
export function findCorners(points: readonly Vec[], thresholdRadians: number): number[] {
  const corners: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (turnAngle(points, i) >= thresholdRadians) corners.push(i);
  }
  return corners;
}

/** Averages each vertex with its neighbours, softening staircase artefacts. */
export function smoothLoop(points: readonly Vec[], strength = 0.5, passes = 1): Vec[] {
  if (points.length < 3 || strength <= 0) return points.slice();
  let current = points.slice();
  for (let pass = 0; pass < passes; pass++) {
    const next: Vec[] = new Array(current.length);
    for (let i = 0; i < current.length; i++) {
      const previous = current[(i - 1 + current.length) % current.length];
      const point = current[i];
      const following = current[(i + 1) % current.length];
      const averageX = (previous.x + following.x) / 2;
      const averageY = (previous.y + following.y) / 2;
      next[i] = {
        x: point.x + (averageX - point.x) * strength,
        y: point.y + (averageY - point.y) * strength,
      };
    }
    current = next;
  }
  return current;
}

/** Drops consecutive duplicate points, which curve fitting cannot handle. */
export function dedupe(points: readonly Vec[], epsilon = 1e-9): Vec[] {
  const result: Vec[] = [];
  for (const p of points) {
    const last = result[result.length - 1];
    if (!last || Math.abs(last.x - p.x) > epsilon || Math.abs(last.y - p.y) > epsilon) {
      result.push(p);
    }
  }
  return result;
}

/**
 * Drops vertices that lie on the straight line between their neighbours,
 * turning a densely sampled loop back into a minimal polygon. Used by the
 * exact tracing mode, which must not move any vertex off the pixel grid.
 */
export function collapseCollinear(points: readonly Vec[], epsilon = 1e-9): Vec[] {
  if (points.length < 3) return points.slice();
  const result: Vec[] = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i - 1 + points.length) % points.length];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const cross =
      (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    if (Math.abs(cross) > epsilon) result.push(current);
  }
  return result.length >= 3 ? result : points.slice();
}
