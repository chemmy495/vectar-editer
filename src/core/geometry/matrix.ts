import type { Vec } from './vec.ts';

/**
 * An affine transform stored in the same column order SVG and Canvas2D use:
 * `[a c e; b d f; 0 0 1]`.
 */
export type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const matrix = (a: number, b: number, c: number, d: number, e: number, f: number): Matrix => ({ a, b, c, d, e, f });

export const identity = (): Matrix => ({ ...IDENTITY });

export const translation = (tx: number, ty: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });

export const scaling = (sx: number, sy: number = sx): Matrix => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });

export function rotation(radians: number): Matrix {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

export function skewing(radiansX: number, radiansY: number): Matrix {
  return { a: 1, b: Math.tan(radiansY), c: Math.tan(radiansX), d: 1, e: 0, f: 0 };
}

/** Returns `m` followed by `n`, i.e. the matrix that applies `n` to the result of `m`. */
export function multiply(n: Matrix, m: Matrix): Matrix {
  return {
    a: n.a * m.a + n.c * m.b,
    b: n.b * m.a + n.d * m.b,
    c: n.a * m.c + n.c * m.d,
    d: n.b * m.c + n.d * m.d,
    e: n.a * m.e + n.c * m.f + n.e,
    f: n.b * m.e + n.d * m.f + n.f,
  };
}

export function compose(...matrices: Matrix[]): Matrix {
  return matrices.reduce((acc, m) => multiply(acc, m), identity());
}

export const applyToPoint = (m: Matrix, p: Vec): Vec => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

/** Applies `m` ignoring translation, which is what direction vectors need. */
export const applyToVector = (m: Matrix, p: Vec): Vec => ({
  x: m.a * p.x + m.c * p.y,
  y: m.b * p.x + m.d * p.y,
});

export const determinant = (m: Matrix): number => m.a * m.d - m.b * m.c;

export function invert(m: Matrix): Matrix | null {
  const det = determinant(m);
  if (Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export const isIdentity = (m: Matrix): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

/**
 * Average absolute scale factor of `m`, used to keep stroke widths and hit
 * tolerances meaningful after a transform.
 */
export function meanScale(m: Matrix): number {
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  return Math.sqrt(Math.abs(sx * sy)) || 1;
}

/** Decomposes into translate/rotate/scale/skew, assuming no mirroring in Y. */
export function decompose(m: Matrix): {
  translateX: number;
  translateY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
} {
  const scaleX = Math.hypot(m.a, m.b);
  const rot = Math.atan2(m.b, m.a);
  const shear = m.a * m.c + m.b * m.d;
  const scaleY = scaleX === 0 ? Math.hypot(m.c, m.d) : determinant(m) / scaleX;
  return {
    translateX: m.e,
    translateY: m.f,
    rotation: rot,
    scaleX,
    scaleY,
    skewX: scaleX === 0 ? 0 : Math.atan2(shear, scaleX * scaleX),
  };
}

export function toSvgString(m: Matrix, precision = 6): string {
  const n = (v: number) => Number(v.toFixed(precision)).toString();
  return `matrix(${n(m.a)} ${n(m.b)} ${n(m.c)} ${n(m.d)} ${n(m.e)} ${n(m.f)})`;
}

const TRANSFORM_RE = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
const NUMBER_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

/** Parses an SVG `transform` attribute into a single matrix. */
export function parseTransform(input: string): Matrix {
  let result = identity();
  if (!input) return result;
  TRANSFORM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRANSFORM_RE.exec(input)) !== null) {
    const name = match[1].toLowerCase();
    const args = (match[2].match(NUMBER_RE) ?? []).map(Number);
    const deg = (v: number) => (v * Math.PI) / 180;
    let step: Matrix | null = null;
    switch (name) {
      case 'matrix':
        if (args.length >= 6) step = matrix(args[0], args[1], args[2], args[3], args[4], args[5]);
        break;
      case 'translate':
        step = translation(args[0] ?? 0, args[1] ?? 0);
        break;
      case 'scale':
        step = scaling(args[0] ?? 1, args.length > 1 ? args[1] : (args[0] ?? 1));
        break;
      case 'rotate':
        if (args.length >= 3) {
          step = compose(translation(args[1], args[2]), rotation(deg(args[0])), translation(-args[1], -args[2]));
        } else {
          step = rotation(deg(args[0] ?? 0));
        }
        break;
      case 'skewx':
        step = skewing(deg(args[0] ?? 0), 0);
        break;
      case 'skewy':
        step = skewing(0, deg(args[0] ?? 0));
        break;
      default:
        break;
    }
    if (step) result = multiply(result, step);
  }
  return result;
}
