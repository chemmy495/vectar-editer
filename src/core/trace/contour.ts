import type { Vec } from '../geometry/vec.ts';

/** A closed boundary loop in pixel-corner coordinates. */
export type Loop = {
  points: Vec[];
  /** Label of the connected component this loop belongs to. */
  component: number;
  /** Signed area; outer loops and hole loops have opposite signs. */
  area: number;
};

/** Directions indexed clockwise on screen: 0 right, 1 down, 2 left, 3 up. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * Labels connected runs of set pixels in `mask`.
 * Uses 8-connectivity, which pairs with 4-connected background so that
 * diagonally touching regions stay a single shape.
 */
export function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; count: number; areas: Int32Array } {
  const labels = new Int32Array(width * height).fill(-1);
  const areaList: number[] = [];
  const stack = new Int32Array(width * height);
  let next = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] >= 0) continue;
    const label = next++;
    let area = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const index = stack[--top];
      area += 1;
      const x = index % width;
      const y = (index / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] === 0 || labels[n] >= 0) continue;
          labels[n] = label;
          stack[top++] = n;
        }
      }
    }
    areaList.push(area);
  }

  return { labels, count: next, areas: Int32Array.from(areaList) };
}

/**
 * Traces every closed boundary of `mask` by walking the cracks between set and
 * clear pixels, always keeping set pixels on the left. Outer boundaries and
 * hole boundaries therefore come out with opposite winding, which makes the
 * resulting path render correctly under a nonzero fill rule without any
 * separate hole detection.
 */
export function traceLoops(
  mask: Uint8Array,
  width: number,
  height: number,
  labels?: Int32Array,
): Loop[] {
  const cornerW = width + 1;
  // One visited flag per directed crack leaving each corner.
  const visited = new Uint8Array(cornerW * (height + 1) * 4);
  const loops: Loop[] = [];

  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;

  /**
   * True when travelling in `dir` from corner (x, y) keeps a set pixel on the
   * left and a clear pixel on the right.
   */
  const canWalk = (x: number, y: number, dir: number): boolean => {
    switch (dir) {
      case 0: return inside(x, y - 1) && !inside(x, y);         // right: set above
      case 1: return inside(x, y) && !inside(x - 1, y);         // down: set to the right
      case 2: return inside(x - 1, y) && !inside(x - 1, y - 1); // left: set below
      default: return inside(x - 1, y - 1) && !inside(x, y - 1); // up: set to the left
    }
  };

  /** The set pixel sitting on the left of the crack, used to pick up a label. */
  const leftPixel = (x: number, y: number, dir: number): number => {
    switch (dir) {
      case 0: return (y - 1) * width + x;
      case 1: return y * width + x;
      case 2: return y * width + (x - 1);
      default: return (y - 1) * width + (x - 1);
    }
  };

  for (let sy = 0; sy <= height; sy++) {
    for (let sx = 0; sx <= width; sx++) {
      for (let sd = 0; sd < 4; sd++) {
        const startKey = (sy * cornerW + sx) * 4 + sd;
        if (visited[startKey] || !canWalk(sx, sy, sd)) continue;

        const component = labels ? labels[leftPixel(sx, sy, sd)] : 0;
        const points: Vec[] = [];
        let x = sx;
        let y = sy;
        let dir = sd;

        while (true) {
          const key = (y * cornerW + x) * 4 + dir;
          if (visited[key]) break;
          visited[key] = 1;
          // Every crack corner becomes a vertex. Keeping the loop densely and
          // evenly sampled is what lets smoothing round pixel staircases
          // without contracting the shape; redundant vertices are removed
          // later by `collapseCollinear` or Ramer-Douglas-Peucker.
          points.push({ x, y });
          x += DX[dir];
          y += DY[dir];
          // Turning right first keeps the set pixels 8-connected at diagonals.
          let nextDir = -1;
          for (const candidate of [(dir + 1) % 4, dir, (dir + 3) % 4]) {
            if (canWalk(x, y, candidate)) {
              nextDir = candidate;
              break;
            }
          }
          if (nextDir < 0) break;
          dir = nextDir;
        }

        if (points.length >= 3) {
          loops.push({ points, component, area: shoelace(points) });
        }
      }
    }
  }

  return loops;
}

/** Signed area of a closed polygon (positive when counter-clockwise on screen). */
export function shoelace(points: readonly Vec[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  }
  return sum / 2;
}

/** Builds a binary mask selecting the pixels whose index equals `value`. */
export function maskFor(indices: Int32Array, value: number): Uint8Array {
  const mask = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) mask[i] = indices[i] === value ? 1 : 0;
  return mask;
}
