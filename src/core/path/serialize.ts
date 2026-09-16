import { add, type Vec } from '../geometry/vec.ts';
import type { PathData, SubPath } from './path.ts';

/** Formats a number without trailing zeros, e.g. `1.500` becomes `1.5`. */
export function num(value: number, precision = 3): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

const isZero = (v: Vec): boolean => v.x === 0 && v.y === 0;

function serializeSubPath(sp: SubPath, precision: number): string {
  if (sp.anchors.length === 0) return '';
  const parts: string[] = [];
  const first = sp.anchors[0];
  parts.push(`M ${num(first.point.x, precision)} ${num(first.point.y, precision)}`);

  const count = sp.closed ? sp.anchors.length : sp.anchors.length - 1;
  for (let i = 0; i < count; i++) {
    const from = sp.anchors[i];
    const to = sp.anchors[(i + 1) % sp.anchors.length];
    const straight = isZero(from.outHandle) && isZero(to.inHandle);
    if (straight) {
      // The final straight segment of a closed subpath is implied by `Z`.
      if (sp.closed && i === count - 1) break;
      parts.push(`L ${num(to.point.x, precision)} ${num(to.point.y, precision)}`);
    } else {
      const c1 = add(from.point, from.outHandle);
      const c2 = add(to.point, to.inHandle);
      parts.push(
        `C ${num(c1.x, precision)} ${num(c1.y, precision)} ${num(c2.x, precision)} ${num(c2.y, precision)} ${num(to.point.x, precision)} ${num(to.point.y, precision)}`,
      );
    }
  }
  if (sp.closed) parts.push('Z');
  return parts.join(' ');
}

/** Serializes path data into an SVG `d` attribute. */
export function serializePathData(path: PathData, precision = 3): string {
  return path.subpaths
    .map((sp) => serializeSubPath(sp, precision))
    .filter((s) => s.length > 0)
    .join(' ');
}
