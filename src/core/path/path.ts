import { add, dist, type Vec } from '../geometry/vec.ts';
import { applyToPoint, applyToVector, type Matrix } from '../geometry/matrix.ts';
import * as bezier from '../geometry/bezier.ts';
import type { Cubic } from '../geometry/bezier.ts';
import { unionAll, type Rect } from '../geometry/rect.ts';

/**
 * How an anchor's two handles relate to each other while editing:
 * `corner` keeps them independent, `smooth` keeps them collinear, and
 * `symmetric` additionally keeps them the same length.
 */
export type AnchorType = 'corner' | 'smooth' | 'symmetric';

/**
 * A node on a path. `inHandle` and `outHandle` are offsets relative to
 * `point`, so moving an anchor moves its handles with it.
 */
export type Anchor = {
  point: Vec;
  inHandle: Vec;
  outHandle: Vec;
  type: AnchorType;
};

export type SubPath = {
  anchors: Anchor[];
  closed: boolean;
};

export type PathData = {
  subpaths: SubPath[];
};

export const anchor = (point: Vec, inHandle: Vec = { x: 0, y: 0 }, outHandle: Vec = { x: 0, y: 0 }, type: AnchorType = 'corner'): Anchor => ({
  point: { ...point },
  inHandle: { ...inHandle },
  outHandle: { ...outHandle },
  type,
});

export const emptyPath = (): PathData => ({ subpaths: [] });

export const isEmpty = (path: PathData): boolean =>
  path.subpaths.every((sp) => sp.anchors.length === 0);

export function clonePath(path: PathData): PathData {
  return {
    subpaths: path.subpaths.map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((a) => ({
        point: { ...a.point },
        inHandle: { ...a.inHandle },
        outHandle: { ...a.outHandle },
        type: a.type,
      })),
    })),
  };
}

/** Number of cubic segments a subpath produces (one extra when closed). */
export function segmentCount(sp: SubPath): number {
  if (sp.anchors.length < 2) return 0;
  return sp.closed ? sp.anchors.length : sp.anchors.length - 1;
}

/** The cubic for segment `index`, running from anchor `index` to the next one. */
export function segmentAt(sp: SubPath, index: number): Cubic | null {
  const count = segmentCount(sp);
  if (index < 0 || index >= count) return null;
  const from = sp.anchors[index];
  const to = sp.anchors[(index + 1) % sp.anchors.length];
  return [from.point, add(from.point, from.outHandle), add(to.point, to.inHandle), to.point];
}

/** Iterates every cubic segment of the path together with its location. */
export function* segments(path: PathData): Generator<{ subpath: number; index: number; curve: Cubic }> {
  for (let s = 0; s < path.subpaths.length; s++) {
    const sp = path.subpaths[s];
    const count = segmentCount(sp);
    for (let i = 0; i < count; i++) {
      const curve = segmentAt(sp, i);
      if (curve) yield { subpath: s, index: i, curve };
    }
  }
}

export function bounds(path: PathData): Rect | null {
  const rects: (Rect | null)[] = [];
  let sawPoint = false;
  for (const sp of path.subpaths) {
    if (sp.anchors.length === 1) {
      const p = sp.anchors[0].point;
      rects.push({ x: p.x, y: p.y, width: 0, height: 0 });
      sawPoint = true;
    }
  }
  for (const { curve } of segments(path)) {
    rects.push(bezier.bounds(curve));
    sawPoint = true;
  }
  return sawPoint ? unionAll(rects) : null;
}

/** Bounding box of anchors and handles, which is what selection UI needs. */
export function controlBounds(path: PathData): Rect | null {
  const points: Vec[] = [];
  for (const sp of path.subpaths) {
    for (const a of sp.anchors) {
      points.push(a.point, add(a.point, a.inHandle), add(a.point, a.outHandle));
    }
  }
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function transformPath(path: PathData, m: Matrix): PathData {
  return {
    subpaths: path.subpaths.map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((a) => ({
        point: applyToPoint(m, a.point),
        inHandle: applyToVector(m, a.inHandle),
        outHandle: applyToVector(m, a.outHandle),
        type: a.type,
      })),
    })),
  };
}

/** Converts each subpath to a polyline. Closed subpaths repeat the first point. */
export function flattenPath(path: PathData, tolerance = 0.25): Vec[][] {
  const result: Vec[][] = [];
  for (const sp of path.subpaths) {
    if (sp.anchors.length === 0) continue;
    const points: Vec[] = [{ ...sp.anchors[0].point }];
    const count = segmentCount(sp);
    for (let i = 0; i < count; i++) {
      const curve = segmentAt(sp, i);
      if (curve) bezier.flatten(curve, tolerance, points);
    }
    result.push(points);
  }
  return result;
}

export function pathLength(path: PathData): number {
  let total = 0;
  for (const { curve } of segments(path)) total += bezier.length(curve);
  return total;
}

/** Sum of subpath signed areas; positive means mostly clockwise in screen space. */
export function signedArea(path: PathData): number {
  let total = 0;
  for (const { curve } of segments(path)) total += bezier.signedArea(curve);
  return total;
}

export function reverseSubPath(sp: SubPath): SubPath {
  const anchors = sp.anchors
    .slice()
    .reverse()
    .map((a) => ({
      point: { ...a.point },
      inHandle: { ...a.outHandle },
      outHandle: { ...a.inHandle },
      type: a.type,
    }));
  return { anchors, closed: sp.closed };
}

export function reversePath(path: PathData): PathData {
  return { subpaths: path.subpaths.map(reverseSubPath) };
}

/** Even-odd containment test against the flattened outline. */
export function containsPoint(path: PathData, p: Vec, tolerance = 0.25): boolean {
  let inside = false;
  for (const poly of flattenPath(path, tolerance)) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Nearest point on the outline, or null for an empty path. */
export function nearestPoint(
  path: PathData,
  p: Vec,
): { subpath: number; index: number; t: number; point: Vec; distance: number } | null {
  let best: { subpath: number; index: number; t: number; point: Vec; distance: number } | null = null;
  for (const { subpath, index, curve } of segments(path)) {
    const hit = bezier.nearestT(curve, p);
    if (!best || hit.distance < best.distance) {
      best = { subpath, index, t: hit.t, point: hit.point, distance: hit.distance };
    }
  }
  if (!best) {
    for (let s = 0; s < path.subpaths.length; s++) {
      const sp = path.subpaths[s];
      if (sp.anchors.length === 1) {
        const point = sp.anchors[0].point;
        return { subpath: s, index: 0, t: 0, point: { ...point }, distance: dist(point, p) };
      }
    }
  }
  return best;
}

/** True when the outline passes within `tolerance` of `p`. */
export function isNearOutline(path: PathData, p: Vec, tolerance: number): boolean {
  const near = nearestPoint(path, p);
  return near !== null && near.distance <= tolerance;
}

/** Builds a path from a list of polylines, with straight segments between points. */
export function fromPolylines(polylines: readonly (readonly Vec[])[], closed = false): PathData {
  return {
    subpaths: polylines
      .filter((poly) => poly.length > 0)
      .map((poly) => ({
        closed,
        anchors: poly.map((p) => anchor(p)),
      })),
  };
}

/** Appends `other`'s subpaths to `path`, returning a new path. */
export function concatPaths(path: PathData, other: PathData): PathData {
  return { subpaths: [...clonePath(path).subpaths, ...clonePath(other).subpaths] };
}

/**
 * Inserts a new anchor at parameter `t` of the given segment, keeping the
 * shape identical by rebuilding the neighbouring handles.
 */
export function insertAnchor(sp: SubPath, segmentIndex: number, t: number): SubPath {
  const curve = segmentAt(sp, segmentIndex);
  if (!curve) return sp;
  const [left, right] = bezier.split(curve, t);
  const anchors = sp.anchors.map((a) => ({
    point: { ...a.point },
    inHandle: { ...a.inHandle },
    outHandle: { ...a.outHandle },
    type: a.type,
  }));
  const fromIndex = segmentIndex;
  const toIndex = (segmentIndex + 1) % anchors.length;
  anchors[fromIndex].outHandle = { x: left[1].x - left[0].x, y: left[1].y - left[0].y };
  anchors[toIndex].inHandle = { x: right[2].x - right[3].x, y: right[2].y - right[3].y };
  const inserted = anchor(
    left[3],
    { x: left[2].x - left[3].x, y: left[2].y - left[3].y },
    { x: right[1].x - right[0].x, y: right[1].y - right[0].y },
    'smooth',
  );
  anchors.splice(segmentIndex + 1, 0, inserted);
  return { anchors, closed: sp.closed };
}
