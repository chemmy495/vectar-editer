import { add, dist, distSq, normalize, scale, sub, type Vec } from '../geometry/vec.ts';
import type { Cubic } from '../geometry/bezier.ts';
import * as bezier from '../geometry/bezier.ts';

/**
 * Curve fitting after Schneider's "An Algorithm for Automatically Fitting
 * Digitized Curves" (Graphics Gems, 1990): fit one cubic by least squares,
 * refine the parameterization, and split at the worst point if it still does
 * not meet the error bound.
 */

const MAX_REPARAMETERIZE_ITERATIONS = 6;

function chordLengthParameterize(points: readonly Vec[], first: number, last: number): number[] {
  const u: number[] = [0];
  for (let i = first + 1; i <= last; i++) {
    u.push(u[i - first - 1] + dist(points[i], points[i - 1]));
  }
  const total = u[u.length - 1];
  if (total === 0) return u.map((_, i) => i / Math.max(1, u.length - 1));
  return u.map((value) => value / total);
}

const B0 = (t: number): number => (1 - t) ** 3;
const B1 = (t: number): number => 3 * t * (1 - t) ** 2;
const B2 = (t: number): number => 3 * t * t * (1 - t);
const B3 = (t: number): number => t ** 3;

/** Least-squares fit of one cubic with the given end tangents. */
function generateBezier(
  points: readonly Vec[],
  first: number,
  last: number,
  uPrime: readonly number[],
  tangent1: Vec,
  tangent2: Vec,
): Cubic {
  const start = points[first];
  const end = points[last];
  const count = last - first + 1;

  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;

  for (let i = 0; i < count; i++) {
    const t = uPrime[i];
    const a1 = scale(tangent1, B1(t));
    const a2 = scale(tangent2, B2(t));
    c00 += a1.x * a1.x + a1.y * a1.y;
    c01 += a1.x * a2.x + a1.y * a2.y;
    c11 += a2.x * a2.x + a2.y * a2.y;

    const base = {
      x: start.x * (B0(t) + B1(t)) + end.x * (B2(t) + B3(t)),
      y: start.y * (B0(t) + B1(t)) + end.y * (B2(t) + B3(t)),
    };
    const tmp = sub(points[first + i], base);
    x0 += a1.x * tmp.x + a1.y * tmp.y;
    x1 += a2.x * tmp.x + a2.y * tmp.y;
  }

  const det = c00 * c11 - c01 * c01;
  let alphaL: number;
  let alphaR: number;
  if (Math.abs(det) < 1e-12) {
    // Degenerate system: fall back to Wu/Barsky's heuristic.
    const chord = dist(start, end) / 3;
    alphaL = chord;
    alphaR = chord;
  } else {
    alphaL = (x0 * c11 - x1 * c01) / det;
    alphaR = (c00 * x1 - c01 * x0) / det;
  }

  const segmentLength = dist(start, end);
  const epsilon = 1e-6 * segmentLength;
  if (alphaL < epsilon || alphaR < epsilon) {
    const chord = segmentLength / 3;
    alphaL = chord;
    alphaR = chord;
  }

  return [start, add(start, scale(tangent1, alphaL)), add(end, scale(tangent2, alphaR)), end];
}

/** One Newton-Raphson step towards the parameter where the curve is closest. */
function newtonRaphsonRootFind(curve: Cubic, point: Vec, u: number): number {
  const d = sub(bezier.evaluate(curve, u), point);
  const d1 = bezier.derivative(curve, u);
  const d2 = bezier.secondDerivative(curve, u);
  const numerator = d.x * d1.x + d.y * d1.y;
  const denominator = d1.x * d1.x + d1.y * d1.y + d.x * d2.x + d.y * d2.y;
  if (Math.abs(denominator) < 1e-12) return u;
  return u - numerator / denominator;
}

function reparameterize(
  points: readonly Vec[],
  first: number,
  last: number,
  u: readonly number[],
  curve: Cubic,
): number[] {
  const result: number[] = [];
  for (let i = 0; i <= last - first; i++) {
    const t = Math.min(1, Math.max(0, newtonRaphsonRootFind(curve, points[first + i], u[i])));
    result.push(t);
  }
  return result;
}

function computeMaxError(
  points: readonly Vec[],
  first: number,
  last: number,
  curve: Cubic,
  u: readonly number[],
): { error: number; splitPoint: number } {
  let maxError = 0;
  let splitPoint = first + Math.floor((last - first) / 2);
  for (let i = first + 1; i < last; i++) {
    const error = distSq(bezier.evaluate(curve, u[i - first]), points[i]);
    if (error > maxError) {
      maxError = error;
      splitPoint = i;
    }
  }
  return { error: maxError, splitPoint };
}

function fitCubicRecursive(
  points: readonly Vec[],
  first: number,
  last: number,
  tangent1: Vec,
  tangent2: Vec,
  errorSq: number,
  depth: number,
  out: Cubic[],
): void {
  const count = last - first + 1;

  if (count === 2) {
    const chord = dist(points[first], points[last]) / 3;
    out.push([
      points[first],
      add(points[first], scale(tangent1, chord)),
      add(points[last], scale(tangent2, chord)),
      points[last],
    ]);
    return;
  }

  let u = chordLengthParameterize(points, first, last);
  let curve = generateBezier(points, first, last, u, tangent1, tangent2);
  let { error, splitPoint } = computeMaxError(points, first, last, curve, u);

  if (error < errorSq) {
    out.push(curve);
    return;
  }

  // The fit is close: refining the parameterization usually pulls it in.
  if (error < errorSq * 16 && depth < 12) {
    for (let i = 0; i < MAX_REPARAMETERIZE_ITERATIONS; i++) {
      u = reparameterize(points, first, last, u, curve);
      curve = generateBezier(points, first, last, u, tangent1, tangent2);
      const next = computeMaxError(points, first, last, curve, u);
      error = next.error;
      splitPoint = next.splitPoint;
      if (error < errorSq) {
        out.push(curve);
        return;
      }
    }
  }

  if (depth >= 24 || splitPoint <= first || splitPoint >= last) {
    out.push(curve);
    return;
  }

  const centerTangent = normalize(sub(points[splitPoint - 1], points[splitPoint + 1]));
  fitCubicRecursive(points, first, splitPoint, tangent1, centerTangent, errorSq, depth + 1, out);
  fitCubicRecursive(
    points,
    splitPoint,
    last,
    { x: -centerTangent.x, y: -centerTangent.y },
    tangent2,
    errorSq,
    depth + 1,
    out,
  );
}

/**
 * Fits a sequence of cubics through `points`. `tolerance` is the maximum
 * allowed distance between the input points and the fitted curve.
 */
export function fitCurve(points: readonly Vec[], tolerance: number, startTangent?: Vec, endTangent?: Vec): Cubic[] {
  if (points.length < 2) return [];
  const out: Cubic[] = [];
  const t1 = startTangent ?? normalize(sub(points[1], points[0]));
  const t2 = endTangent ?? normalize(sub(points[points.length - 2], points[points.length - 1]));
  fitCubicRecursive(points, 0, points.length - 1, t1, t2, Math.max(1e-9, tolerance * tolerance), 0, out);
  return out;
}

/**
 * Fits a closed loop. `corners` lists indices that must stay sharp; each run
 * between consecutive corners is fitted independently. With no corners the
 * whole loop is fitted as one smooth curve that joins back on itself.
 */
export function fitClosedLoop(points: readonly Vec[], tolerance: number, corners: readonly number[] = []): Cubic[] {
  if (points.length < 3) return [];

  if (corners.length === 0) {
    // Rotate so the loop starts and ends at the same vertex, and give both
    // ends the same tangent so the join stays smooth.
    const looped = [...points, points[0]];
    const tangent = normalize(sub(points[1], points[points.length - 1]));
    return fitCurve(looped, tolerance, tangent, { x: -tangent.x, y: -tangent.y });
  }

  const sorted = [...new Set(corners)].sort((a, b) => a - b);
  const result: Cubic[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = sorted[(i + 1) % sorted.length];
    const run: Vec[] = [];
    let index = start;
    while (true) {
      run.push(points[index]);
      if (index === end && run.length > 1) break;
      index = (index + 1) % points.length;
      if (run.length > points.length) break;
    }
    if (run.length >= 2) result.push(...fitCurve(run, tolerance));
  }
  return result;
}
