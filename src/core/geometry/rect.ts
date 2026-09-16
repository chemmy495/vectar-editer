import type { Vec } from './vec.ts';
import { applyToPoint, type Matrix } from './matrix.ts';

/** An axis-aligned rectangle. `width`/`height` are never negative. */
export type Rect = { x: number; y: number; width: number; height: number };

export const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

export const left = (r: Rect): number => r.x;
export const top = (r: Rect): number => r.y;
export const right = (r: Rect): number => r.x + r.width;
export const bottom = (r: Rect): number => r.y + r.height;
export const center = (r: Rect): Vec => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

export function fromPoints(points: readonly Vec[]): Rect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function fromCorners(a: Vec, b: Vec): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}

export function unionAll(rects: readonly (Rect | null)[]): Rect | null {
  return rects.reduce<Rect | null>((acc, r) => union(acc, r), null);
}

export function intersects(a: Rect, b: Rect): boolean {
  return !(right(a) < b.x || right(b) < a.x || bottom(a) < b.y || bottom(b) < a.y);
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    right(inner) <= right(outer) &&
    bottom(inner) <= bottom(outer)
  );
}

export function containsPoint(r: Rect, p: Vec): boolean {
  return p.x >= r.x && p.x <= right(r) && p.y >= r.y && p.y <= bottom(r);
}

export function inflate(r: Rect, amount: number): Rect {
  return { x: r.x - amount, y: r.y - amount, width: r.width + amount * 2, height: r.height + amount * 2 };
}

export function corners(r: Rect): [Vec, Vec, Vec, Vec] {
  return [
    { x: r.x, y: r.y },
    { x: right(r), y: r.y },
    { x: right(r), y: bottom(r) },
    { x: r.x, y: bottom(r) },
  ];
}

/** Bounding box of `r` after `m` is applied to its corners. */
export function transform(r: Rect, m: Matrix): Rect {
  return fromPoints(corners(r).map((p) => applyToPoint(m, p))) ?? { ...EMPTY_RECT };
}

export const isEmpty = (r: Rect): boolean => r.width <= 0 && r.height <= 0;
