import { add, dist, distSq, lerp, scale, sub, type Vec } from './vec.ts';
import { fromPoints, type Rect } from './rect.ts';

/** A cubic bezier segment: start, two control points, end. */
export type Cubic = readonly [Vec, Vec, Vec, Vec];

export function evaluate(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
    y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
  };
}

/** First derivative of the curve at `t` (a tangent vector, not normalized). */
export function derivative(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = 3 * mt * mt;
  const b = 6 * mt * t;
  const d = 3 * t * t;
  return {
    x: a * (c[1].x - c[0].x) + b * (c[2].x - c[1].x) + d * (c[3].x - c[2].x),
    y: a * (c[1].y - c[0].y) + b * (c[2].y - c[1].y) + d * (c[3].y - c[2].y),
  };
}

export function secondDerivative(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  return {
    x: 6 * mt * (c[2].x - 2 * c[1].x + c[0].x) + 6 * t * (c[3].x - 2 * c[2].x + c[1].x),
    y: 6 * mt * (c[2].y - 2 * c[1].y + c[0].y) + 6 * t * (c[3].y - 2 * c[2].y + c[1].y),
  };
}

/** Splits `c` at `t` into two curves that together trace the same shape. */
export function split(c: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerp(c[0], c[1], t);
  const p12 = lerp(c[1], c[2], t);
  const p23 = lerp(c[2], c[3], t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const mid = lerp(p012, p123, t);
  return [
    [c[0], p01, p012, mid],
    [mid, p123, p23, c[3]],
  ];
}

/** Returns the portion of `c` between `t0` and `t1`. */
export function subCurve(c: Cubic, t0: number, t1: number): Cubic {
  if (t0 > t1) return subCurve(c, t1, t0);
  const right = split(c, t0)[1];
  if (t0 >= 1) return [c[3], c[3], c[3], c[3]];
  return split(right, (t1 - t0) / (1 - t0))[0];
}

/** Roots of the derivative in (0, 1), where the curve reaches its extrema. */
export function extremaT(c: Cubic): number[] {
  const roots: number[] = [];
  for (const axis of ['x', 'y'] as const) {
    const p0 = c[0][axis];
    const p1 = c[1][axis];
    const p2 = c[2][axis];
    const p3 = c[3][axis];
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const d = p1 - p0;
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) {
        const t = -d / b;
        if (t > 0 && t < 1) roots.push(t);
      }
      continue;
    }
    const disc = b * b - 4 * a * d;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const t of [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]) {
      if (t > 0 && t < 1) roots.push(t);
    }
  }
  return roots.sort((x, y) => x - y);
}

/** Tight bounding box, computed from the endpoints plus the true extrema. */
export function bounds(c: Cubic): Rect {
  const points: Vec[] = [c[0], c[3]];
  for (const t of extremaT(c)) points.push(evaluate(c, t));
  return fromPoints(points) ?? { x: c[0].x, y: c[0].y, width: 0, height: 0 };
}

/** True when all four points are close enough to collinear to treat as a line. */
export function isFlat(c: Cubic, tolerance: number): boolean {
  const ux = 3 * c[1].x - 2 * c[0].x - c[3].x;
  const uy = 3 * c[1].y - 2 * c[0].y - c[3].y;
  const vx = 3 * c[2].x - c[0].x - 2 * c[3].x;
  const vy = 3 * c[2].y - c[0].y - 2 * c[3].y;
  const m = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy);
  return m <= 16 * tolerance * tolerance;
}

/**
 * Approximates `c` with a polyline. The start point is not emitted so that
 * consecutive segments can be appended without duplicating vertices.
 */
export function flatten(c: Cubic, tolerance = 0.25, out: Vec[] = []): Vec[] {
  const recurse = (curve: Cubic, depth: number): void => {
    if (depth >= 16 || isFlat(curve, tolerance)) {
      out.push({ x: curve[3].x, y: curve[3].y });
      return;
    }
    const [l, r] = split(curve, 0.5);
    recurse(l, depth + 1);
    recurse(r, depth + 1);
  };
  recurse(c, 0);
  return out;
}

const LEGENDRE: ReadonlyArray<readonly [number, number]> = [
  [0.1894506104550685, -0.0950125098376374],
  [0.1894506104550685, 0.0950125098376374],
  [0.1826034150449236, -0.2816035507792589],
  [0.1826034150449236, 0.2816035507792589],
  [0.1691565193950025, -0.4580167776572274],
  [0.1691565193950025, 0.4580167776572274],
  [0.1495959888165767, -0.6178762444026438],
  [0.1495959888165767, 0.6178762444026438],
  [0.1246289712555339, -0.7554044083550030],
  [0.1246289712555339, 0.7554044083550030],
  [0.0951585116824928, -0.8656312023878318],
  [0.0951585116824928, 0.8656312023878318],
  [0.0622535239386479, -0.9445750230732326],
  [0.0622535239386479, 0.9445750230732326],
  [0.0271524594117541, -0.9894009349916499],
  [0.0271524594117541, 0.9894009349916499],
];

/** Arc length via 16-point Gauss-Legendre quadrature. */
export function length(c: Cubic): number {
  let sum = 0;
  for (const [weight, abscissa] of LEGENDRE) {
    const t = 0.5 * abscissa + 0.5;
    const d = derivative(c, t);
    sum += weight * Math.hypot(d.x, d.y);
  }
  return 0.5 * sum;
}

/** Straight-line distance from start to end, a cheap length lower bound. */
export const chordLength = (c: Cubic): number => dist(c[0], c[3]);

/** Finds the `t` on `c` nearest to `p` by coarse sampling then local refinement. */
export function nearestT(c: Cubic, p: Vec, samples = 32): { t: number; point: Vec; distance: number } {
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const d = distSq(evaluate(c, t), p);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  let step = 1 / samples / 2;
  for (let i = 0; i < 24 && step > 1e-6; i++) {
    const candidates = [bestT - step, bestT + step];
    for (const t of candidates) {
      if (t < 0 || t > 1) continue;
      const d = distSq(evaluate(c, t), p);
      if (d < bestD) {
        bestD = d;
        bestT = t;
      }
    }
    step /= 2;
  }
  return { t: bestT, point: evaluate(c, bestT), distance: Math.sqrt(bestD) };
}

/** Builds the cubic that draws the straight line from `a` to `b`. */
export function fromLine(a: Vec, b: Vec): Cubic {
  return [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b];
}

/** Transforms the curve by moving every control point with `fn`. */
export function mapPoints(c: Cubic, fn: (p: Vec) => Vec): Cubic {
  return [fn(c[0]), fn(c[1]), fn(c[2]), fn(c[3])];
}

/**
 * Offsets the four control points along the curve normal, an approximation
 * that is good enough for the small offsets brush outlines need.
 */
export function offsetApprox(c: Cubic, distance: number): Cubic {
  const normalAt = (t: number): Vec => {
    const d = derivative(c, t);
    const l = Math.hypot(d.x, d.y);
    if (l === 0) return { x: 0, y: 0 };
    return { x: -d.y / l, y: d.x / l };
  };
  const n0 = normalAt(0);
  const n1 = normalAt(1);
  return [
    add(c[0], scale(n0, distance)),
    add(c[1], scale(n0, distance)),
    add(c[2], scale(n1, distance)),
    add(c[3], scale(n1, distance)),
  ];
}

/** Signed area contribution of the curve, used for winding/orientation tests. */
export function signedArea(c: Cubic): number {
  const [p0, p1, p2, p3] = c;
  return (
    (3 *
      (p3.y * (p0.x + 3 * p1.x + 6 * p2.x) -
        p0.y * (6 * p1.x + 3 * p2.x + p3.x) +
        3 * p1.y * (-2 * p0.x + p2.x + p3.x) -
        3 * p2.y * (-p0.x - p1.x + 2 * p3.x))) /
    20
  );
}

export const startTangent = (c: Cubic): Vec => {
  const d = sub(c[1], c[0]);
  if (Math.hypot(d.x, d.y) > 1e-9) return d;
  const d2 = sub(c[2], c[0]);
  return Math.hypot(d2.x, d2.y) > 1e-9 ? d2 : sub(c[3], c[0]);
};

export const endTangent = (c: Cubic): Vec => {
  const d = sub(c[2], c[3]);
  if (Math.hypot(d.x, d.y) > 1e-9) return d;
  const d2 = sub(c[1], c[3]);
  return Math.hypot(d2.x, d2.y) > 1e-9 ? d2 : sub(c[0], c[3]);
};
