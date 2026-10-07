import type { Vec } from '../geometry/vec.ts';
import type { Rect } from '../geometry/rect.ts';
import { anchor, type PathData } from './path.ts';

/** Control-point ratio that makes a cubic approximate a quarter circle. */
export const KAPPA = 0.5522847498307936;

export function rectanglePath(r: Rect, cornerRadius = 0): PathData {
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  const radius = Math.max(0, Math.min(cornerRadius, Math.min(r.width, r.height) / 2));

  if (radius <= 0) {
    return {
      subpaths: [
        {
          closed: true,
          anchors: [
            anchor({ x: x0, y: y0 }),
            anchor({ x: x1, y: y0 }),
            anchor({ x: x1, y: y1 }),
            anchor({ x: x0, y: y1 }),
          ],
        },
      ],
    };
  }

  const h = radius * KAPPA;
  return {
    subpaths: [
      {
        closed: true,
        anchors: [
          anchor({ x: x0 + radius, y: y0 }, { x: -h, y: 0 }, { x: 0, y: 0 }, 'corner'),
          anchor({ x: x1 - radius, y: y0 }, { x: 0, y: 0 }, { x: h, y: 0 }, 'corner'),
          anchor({ x: x1, y: y0 + radius }, { x: 0, y: -h }, { x: 0, y: 0 }, 'corner'),
          anchor({ x: x1, y: y1 - radius }, { x: 0, y: 0 }, { x: 0, y: h }, 'corner'),
          anchor({ x: x1 - radius, y: y1 }, { x: h, y: 0 }, { x: 0, y: 0 }, 'corner'),
          anchor({ x: x0 + radius, y: y1 }, { x: 0, y: 0 }, { x: -h, y: 0 }, 'corner'),
          anchor({ x: x0, y: y1 - radius }, { x: 0, y: h }, { x: 0, y: 0 }, 'corner'),
          anchor({ x: x0, y: y0 + radius }, { x: 0, y: 0 }, { x: 0, y: -h }, 'corner'),
        ],
      },
    ],
  };
}

/** Ellipse inscribed in `r`, drawn as four cubic quarters. */
export function ellipsePath(r: Rect): PathData {
  const rx = r.width / 2;
  const ry = r.height / 2;
  const cx = r.x + rx;
  const cy = r.y + ry;
  const hx = rx * KAPPA;
  const hy = ry * KAPPA;
  return {
    subpaths: [
      {
        closed: true,
        anchors: [
          anchor({ x: cx, y: cy - ry }, { x: -hx, y: 0 }, { x: hx, y: 0 }, 'symmetric'),
          anchor({ x: cx + rx, y: cy }, { x: 0, y: -hy }, { x: 0, y: hy }, 'symmetric'),
          anchor({ x: cx, y: cy + ry }, { x: hx, y: 0 }, { x: -hx, y: 0 }, 'symmetric'),
          anchor({ x: cx - rx, y: cy }, { x: 0, y: hy }, { x: 0, y: -hy }, 'symmetric'),
        ],
      },
    ],
  };
}

/** Regular polygon inscribed in `r`, with the first vertex pointing up. */
export function polygonPath(r: Rect, sides: number): PathData {
  const count = Math.max(3, Math.round(sides));
  const rx = r.width / 2;
  const ry = r.height / 2;
  const cx = r.x + rx;
  const cy = r.y + ry;
  const anchors = [];
  for (let i = 0; i < count; i++) {
    const theta = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    anchors.push(anchor({ x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta) }));
  }
  return { subpaths: [{ closed: true, anchors }] };
}

/** Star with `points` outer vertices; `innerRatio` is the inner radius fraction. */
export function starPath(r: Rect, points: number, innerRatio = 0.5): PathData {
  const count = Math.max(3, Math.round(points));
  const ratio = Math.max(0.01, Math.min(1, innerRatio));
  const rx = r.width / 2;
  const ry = r.height / 2;
  const cx = r.x + rx;
  const cy = r.y + ry;
  const anchors = [];
  for (let i = 0; i < count * 2; i++) {
    const theta = -Math.PI / 2 + (i * Math.PI) / count;
    const k = i % 2 === 0 ? 1 : ratio;
    anchors.push(anchor({ x: cx + rx * k * Math.cos(theta), y: cy + ry * k * Math.sin(theta) }));
  }
  return { subpaths: [{ closed: true, anchors }] };
}

export function linePath(from: Vec, to: Vec): PathData {
  return { subpaths: [{ closed: false, anchors: [anchor(from), anchor(to)] }] };
}

/** Open polyline through `points`, with straight segments. */
export function polylinePath(points: readonly Vec[], closed = false): PathData {
  if (points.length === 0) return { subpaths: [] };
  return { subpaths: [{ closed, anchors: points.map((p) => anchor(p)) }] };
}
