import { sub, type Vec } from '../geometry/vec.ts';
import type { Cubic } from '../geometry/bezier.ts';
import { anchor, type Anchor, type PathData, type SubPath } from './path.ts';

/**
 * Turns a chain of cubics into a subpath. Consecutive curves are assumed to
 * share endpoints; for a closed subpath the last curve must end where the
 * first one starts.
 */
export function subPathFromCubics(cubics: readonly Cubic[], closed: boolean): SubPath | null {
  if (cubics.length === 0) return null;

  const anchors: Anchor[] = [];
  for (let i = 0; i < cubics.length; i++) {
    const curve = cubics[i];
    const previous = i === 0 ? (closed ? cubics[cubics.length - 1] : null) : cubics[i - 1];
    anchors.push(
      anchor(
        curve[0],
        previous ? sub(previous[2], previous[3]) : { x: 0, y: 0 },
        sub(curve[1], curve[0]),
        'smooth',
      ),
    );
  }

  if (!closed) {
    const last = cubics[cubics.length - 1];
    anchors.push(anchor(last[3], sub(last[2], last[3]), { x: 0, y: 0 }, 'smooth'));
  }

  return { anchors, closed };
}

export function pathFromCubicLoops(loops: readonly (readonly Cubic[])[]): PathData {
  const subpaths: SubPath[] = [];
  for (const loop of loops) {
    const subpath = subPathFromCubics(loop, true);
    if (subpath) subpaths.push(subpath);
  }
  return { subpaths };
}

/** Straight-segment subpath through `points`. */
export function subPathFromPoints(points: readonly Vec[], closed: boolean): SubPath | null {
  if (points.length < 2) return null;
  return { anchors: points.map((p) => anchor(p)), closed };
}
