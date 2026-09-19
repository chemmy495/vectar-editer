import type { Vec } from '../geometry/vec.ts';
import { anchor, type Anchor, type PathData, type SubPath } from './path.ts';

/** Tokenizes an SVG `d` attribute into commands with their numeric arguments. */
type Token = { command: string; args: number[] };

const ARG_COUNT: Record<string, number> = {
  m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
};

function tokenize(d: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = d.length;
  let command = '';

  const skipSeparators = () => {
    while (i < n) {
      const ch = d[i];
      if (ch === ' ' || ch === ',' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') i++;
      else break;
    }
  };

  const readNumber = (): number | null => {
    skipSeparators();
    const start = i;
    if (i < n && (d[i] === '+' || d[i] === '-')) i++;
    let digits = 0;
    while (i < n && d[i] >= '0' && d[i] <= '9') { i++; digits++; }
    if (i < n && d[i] === '.') {
      i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') { i++; digits++; }
    }
    if (digits === 0) { i = start; return null; }
    if (i < n && (d[i] === 'e' || d[i] === 'E')) {
      const save = i;
      i++;
      if (i < n && (d[i] === '+' || d[i] === '-')) i++;
      let expDigits = 0;
      while (i < n && d[i] >= '0' && d[i] <= '9') { i++; expDigits++; }
      if (expDigits === 0) i = save;
    }
    return Number(d.slice(start, i));
  };

  // Arc flags may be written without separators ("a1 1 0 011 1"), so they are
  // read one character at a time rather than as general numbers.
  const readFlag = (): number | null => {
    skipSeparators();
    if (i < n && (d[i] === '0' || d[i] === '1')) {
      const value = d[i] === '1' ? 1 : 0;
      i++;
      return value;
    }
    return readNumber();
  };

  while (i < n) {
    skipSeparators();
    if (i >= n) break;
    const ch = d[i];
    let readCommandLetter = false;
    if (/[a-zA-Z]/.test(ch)) {
      command = ch;
      i++;
      readCommandLetter = true;
    } else if (!command) {
      break; // Numbers before any command are not valid path data.
    } else if (command === 'M') {
      command = 'L';
    } else if (command === 'm') {
      command = 'l';
    }
    const lower = command.toLowerCase();
    const count = ARG_COUNT[lower];
    if (count === undefined) break;
    if (count === 0) {
      // `Z` takes no arguments, so a number after one cannot be a repeat of it.
      // Stopping here matches how browsers treat the rest of the data as
      // malformed, and stops this loop from spinning without consuming input.
      if (!readCommandLetter) break;
      tokens.push({ command, args: [] });
      continue;
    }
    const args: number[] = [];
    for (let k = 0; k < count; k++) {
      const isFlag = lower === 'a' && (k === 3 || k === 4);
      const value = isFlag ? readFlag() : readNumber();
      if (value === null) break;
      args.push(value);
    }
    if (args.length < count) break;
    tokens.push({ command, args });
  }
  return tokens;
}

/** Converts an SVG elliptical arc into up to four cubic segments. */
export function arcToCubics(
  from: Vec,
  rx: number,
  ry: number,
  xAxisRotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: Vec,
): Array<[Vec, Vec, Vec]> {
  // Returns [control1, control2, end] triples; the caller already has `from`.
  if (from.x === to.x && from.y === to.y) return [];
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  if (radiusX === 0 || radiusY === 0) {
    return [[from, to, to]];
  }
  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    radiusX *= s;
    radiusY *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num = radiusX * radiusX * radiusY * radiusY - radiusX * radiusX * y1p * y1p - radiusY * radiusY * x1p * x1p;
  const den = radiusX * radiusX * y1p * y1p + radiusY * radiusY * x1p * x1p;
  const co = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * radiusX * y1p) / radiusY;
  const cyp = (-co * radiusY * x1p) / radiusX;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  const angleOf = (ux: number, uy: number, vx: number, vy: number): number => {
    const dotProduct = ux * vx + uy * vy;
    const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let value = lengths === 0 ? 0 : Math.acos(Math.min(1, Math.max(-1, dotProduct / lengths)));
    if (ux * vy - uy * vx < 0) value = -value;
    return value;
  };

  const startAngle = angleOf(1, 0, (x1p - cxp) / radiusX, (y1p - cyp) / radiusY);
  let deltaAngle = angleOf(
    (x1p - cxp) / radiusX,
    (y1p - cyp) / radiusY,
    (-x1p - cxp) / radiusX,
    (-y1p - cyp) / radiusY,
  );
  if (!sweep && deltaAngle > 0) deltaAngle -= 2 * Math.PI;
  else if (sweep && deltaAngle < 0) deltaAngle += 2 * Math.PI;

  const pieces = Math.max(1, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 2)));
  const step = deltaAngle / pieces;
  const alpha = (4 / 3) * Math.tan(step / 4);

  const pointAt = (theta: number): Vec => ({
    x: cx + radiusX * Math.cos(theta) * cosPhi - radiusY * Math.sin(theta) * sinPhi,
    y: cy + radiusX * Math.cos(theta) * sinPhi + radiusY * Math.sin(theta) * cosPhi,
  });
  const tangentAt = (theta: number): Vec => ({
    x: -radiusX * Math.sin(theta) * cosPhi - radiusY * Math.cos(theta) * sinPhi,
    y: -radiusX * Math.sin(theta) * sinPhi + radiusY * Math.cos(theta) * cosPhi,
  });

  const result: Array<[Vec, Vec, Vec]> = [];
  for (let k = 0; k < pieces; k++) {
    const t0 = startAngle + k * step;
    const t1 = t0 + step;
    const p0 = pointAt(t0);
    const p1 = pointAt(t1);
    const d0 = tangentAt(t0);
    const d1 = tangentAt(t1);
    result.push([
      { x: p0.x + alpha * d0.x, y: p0.y + alpha * d0.y },
      { x: p1.x - alpha * d1.x, y: p1.y - alpha * d1.y },
      k === pieces - 1 ? { ...to } : p1,
    ]);
  }
  return result;
}

/**
 * Parses an SVG `d` attribute into path data. Unknown or malformed trailing
 * commands are ignored rather than throwing, matching how browsers render.
 */
export function parsePathData(d: string): PathData {
  const tokens = tokenize(d ?? '');
  const subpaths: SubPath[] = [];
  let current: SubPath | null = null;
  let cursor: Vec = { x: 0, y: 0 };
  let subpathStart: Vec = { x: 0, y: 0 };
  let lastCubicControl: Vec | null = null;
  let lastQuadControl: Vec | null = null;

  const startSubpath = (p: Vec): SubPath => {
    const subpath: SubPath = { anchors: [anchor(p)], closed: false };
    current = subpath;
    subpaths.push(subpath);
    subpathStart = { ...p };
    return subpath;
  };

  // Reading through a function keeps the declared type intact: TypeScript does
  // not track the assignments these closures make to `current`.
  const getCurrent = (): SubPath | null => current;

  const ensureCurrent = (): SubPath => getCurrent() ?? startSubpath(cursor);

  /** Appends a cubic whose control points are absolute coordinates. */
  const appendCubic = (c1: Vec, c2: Vec, end: Vec) => {
    const subpath = ensureCurrent();
    const prev: Anchor | undefined = subpath.anchors[subpath.anchors.length - 1];
    if (!prev) return;
    prev.outHandle = { x: c1.x - prev.point.x, y: c1.y - prev.point.y };
    subpath.anchors.push(anchor(end, { x: c2.x - end.x, y: c2.y - end.y }, { x: 0, y: 0 }));
    cursor = { ...end };
  };

  const appendLine = (end: Vec) => {
    const subpath = ensureCurrent();
    const prev: Anchor | undefined = subpath.anchors[subpath.anchors.length - 1];
    if (!prev) return;
    prev.outHandle = { x: 0, y: 0 };
    subpath.anchors.push(anchor(end));
    cursor = { ...end };
  };

  for (const token of tokens) {
    const isRelative = token.command >= 'a' && token.command <= 'z';
    const cmd = token.command.toLowerCase();
    const a = token.args;
    const abs = (x: number, y: number): Vec =>
      isRelative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };

    switch (cmd) {
      case 'm': {
        const p = abs(a[0], a[1]);
        startSubpath(p);
        cursor = { ...p };
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'l': {
        appendLine(abs(a[0], a[1]));
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'h': {
        appendLine(isRelative ? { x: cursor.x + a[0], y: cursor.y } : { x: a[0], y: cursor.y });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'v': {
        appendLine(isRelative ? { x: cursor.x, y: cursor.y + a[0] } : { x: cursor.x, y: a[0] });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'c': {
        const c1 = abs(a[0], a[1]);
        const c2 = abs(a[2], a[3]);
        const end = abs(a[4], a[5]);
        appendCubic(c1, c2, end);
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case 's': {
        const c2 = abs(a[0], a[1]);
        const end = abs(a[2], a[3]);
        const c1: Vec = lastCubicControl
          ? { x: 2 * cursor.x - lastCubicControl.x, y: 2 * cursor.y - lastCubicControl.y }
          : { ...cursor };
        appendCubic(c1, c2, end);
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case 'q': {
        const q = abs(a[0], a[1]);
        const end = abs(a[2], a[3]);
        const c1 = { x: cursor.x + (2 / 3) * (q.x - cursor.x), y: cursor.y + (2 / 3) * (q.y - cursor.y) };
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
        appendCubic(c1, c2, end);
        lastQuadControl = q;
        lastCubicControl = null;
        break;
      }
      case 't': {
        const end = abs(a[0], a[1]);
        const q: Vec = lastQuadControl
          ? { x: 2 * cursor.x - lastQuadControl.x, y: 2 * cursor.y - lastQuadControl.y }
          : { ...cursor };
        const c1 = { x: cursor.x + (2 / 3) * (q.x - cursor.x), y: cursor.y + (2 / 3) * (q.y - cursor.y) };
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
        appendCubic(c1, c2, end);
        lastQuadControl = q;
        lastCubicControl = null;
        break;
      }
      case 'a': {
        const end = abs(a[5], a[6]);
        const pieces = arcToCubics(cursor, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, end);
        for (const [c1, c2, p] of pieces) appendCubic(c1, c2, p);
        if (pieces.length === 0) cursor = { ...end };
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'z': {
        const subpath = getCurrent();
        if (subpath && subpath.anchors.length > 0) {
          subpath.closed = true;
          const first = subpath.anchors[0];
          const last = subpath.anchors[subpath.anchors.length - 1];
          // A `z` that lands exactly on the start point does not need the
          // duplicate anchor; merge its incoming handle into the first anchor.
          if (subpath.anchors.length > 1 && Math.hypot(last.point.x - first.point.x, last.point.y - first.point.y) < 1e-9) {
            first.inHandle = { ...last.inHandle };
            subpath.anchors.pop();
          }
          cursor = { ...subpathStart };
        }
        current = null;
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      default:
        break;
    }
  }

  return { subpaths: subpaths.filter((sp) => sp.anchors.length > 0) };
}
