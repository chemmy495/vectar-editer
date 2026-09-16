/** A point (or vector) in 2D space. */
export type Vec = { x: number; y: number };

export const vec = (x: number, y: number): Vec => ({ x, y });

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const lenSq = (a: Vec): number => a.x * a.x + a.y * a.y;
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a: Vec, b: Vec): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/** Returns a unit-length copy of `a`, or `{0,0}` when `a` has no length. */
export function normalize(a: Vec): Vec {
  const l = Math.hypot(a.x, a.y);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Rotates `a` 90 degrees counter-clockwise in screen coordinates. */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });

export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export function rotate(a: Vec, radians: number, origin: Vec = { x: 0, y: 0 }): Vec {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const dx = a.x - origin.x;
  const dy = a.y - origin.y;
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
}

export const angle = (a: Vec): number => Math.atan2(a.y, a.x);

export const equals = (a: Vec, b: Vec, epsilon = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;

export const clone = (a: Vec): Vec => ({ x: a.x, y: a.y });
