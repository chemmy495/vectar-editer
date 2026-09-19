import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantize, type ImageData8 } from '../src/core/trace/quantize.ts';
import { labelComponents, traceLoops, shoelace } from '../src/core/trace/contour.ts';
import { simplifyLoop, simplifyPolyline, dedupe, findCorners, collapseCollinear } from '../src/core/trace/simplify.ts';
import { fitCurve, fitClosedLoop } from '../src/core/trace/fit.ts';
import { traceImage, DEFAULT_TRACE_OPTIONS } from '../src/core/trace/trace.ts';
import * as P from '../src/core/path/path.ts';
import * as bezier from '../src/core/geometry/bezier.ts';
import { colorDistanceSq } from '../src/core/model/color.ts';
import type { Vec } from '../src/core/geometry/vec.ts';

/** Builds an image by painting with a callback returning `[r,g,b,a]`. */
function makeImage(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): ImageData8 {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width, height, data };
}

function maskFromRows(rows: string[]): { mask: Uint8Array; width: number; height: number } {
  const height = rows.length;
  const width = rows[0].length;
  const mask = new Uint8Array(width * height);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { mask[y * width + x] = ch === '#' ? 1 : 0; }));
  return { mask, width, height };
}

test('quantize finds the exact colours of a flat image', () => {
  const image = makeImage(40, 40, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const { palette, indices } = quantize(image, 4);
  assert.ok(palette.length >= 2);
  const leftColor = palette[indices[0]];
  const rightColor = palette[indices[39]];
  assert.ok(colorDistanceSq(leftColor, { r: 255, g: 0, b: 0, a: 1 }) < 100);
  assert.ok(colorDistanceSq(rightColor, { r: 0, g: 0, b: 255, a: 1 }) < 100);
});

test('quantize marks transparent pixels as unassigned', () => {
  const image = makeImage(10, 10, (x) => (x < 5 ? [10, 20, 30, 255] : [0, 0, 0, 0]));
  const { indices } = quantize(image, 4);
  assert.equal(indices[0] >= 0, true);
  assert.equal(indices[9], -1);
});

test('quantize on an empty image yields no palette', () => {
  const image = makeImage(4, 4, () => [0, 0, 0, 0]);
  const { palette, indices } = quantize(image, 8);
  assert.equal(palette.length, 0);
  assert.ok([...indices].every((i) => i === -1));
});

test('labelComponents separates regions and counts area', () => {
  const { mask, width, height } = maskFromRows(['##.##', '##.##', '.....', '##.##', '##.##']);
  const { count, areas } = labelComponents(mask, width, height);
  assert.equal(count, 4);
  assert.deepEqual([...areas], [4, 4, 4, 4]);
});

test('labelComponents treats diagonal contact as connected', () => {
  const { mask, width, height } = maskFromRows(['#.', '.#']);
  assert.equal(labelComponents(mask, width, height).count, 1);
});

test('traceLoops walks a region boundary in unit steps', () => {
  const { mask, width, height } = maskFromRows(['..', '.#']);
  const loops = traceLoops(mask, width, height);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].points.length, 4);

  // A 2x2 block has a perimeter of 8 cracks, all of them emitted.
  const block = maskFromRows(['##', '##']);
  const blockLoops = traceLoops(block.mask, block.width, block.height);
  assert.equal(blockLoops[0].points.length, 8);
  assert.equal(collapseCollinear(blockLoops[0].points).length, 4);
});

test('a region with a hole yields two loops of opposite winding', () => {
  const { mask, width, height } = maskFromRows(['#####', '#####', '##.##', '#####', '#####']);
  const loops = traceLoops(mask, width, height);
  assert.equal(loops.length, 2);
  const outer = loops.find((l) => Math.abs(l.area) === 25)!;
  const hole = loops.find((l) => Math.abs(l.area) === 1)!;
  assert.ok(outer && hole);
  assert.ok(Math.sign(outer.area) !== Math.sign(hole.area), 'hole must wind the other way');
});

test('traced loops are attributed to their component', () => {
  const { mask, width, height } = maskFromRows(['##.##', '##.##', '.....', '##.##', '##.##']);
  const { labels } = labelComponents(mask, width, height);
  const loops = traceLoops(mask, width, height, labels);
  assert.equal(new Set(loops.map((l) => l.component)).size, 4);
});

test('loop vertices enclose the region area', () => {
  const { mask, width, height } = maskFromRows(['.....', '.###.', '.###.', '.###.', '.....']);
  const loops = traceLoops(mask, width, height);
  assert.equal(loops.length, 1);
  assert.equal(Math.abs(shoelace(loops[0].points)), 9);
});

test('RDP keeps endpoints and drops collinear points', () => {
  const line: Vec[] = [{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }];
  assert.deepEqual(simplifyPolyline(line, 1), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  assert.equal(simplifyPolyline(line, 0.01).length, 3);
});

test('simplifyLoop keeps a square square', () => {
  const square: Vec[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(simplifyLoop(square, 1).length, 4);
});

test('simplifyLoop removes staircase jitter from a diagonal edge', () => {
  const staircase: Vec[] = [];
  for (let i = 0; i <= 20; i++) staircase.push({ x: i, y: i }, { x: i + 1, y: i });
  staircase.push({ x: 21, y: 30 }, { x: 0, y: 30 });
  const simplified = simplifyLoop(staircase, 1.5);
  assert.ok(simplified.length < staircase.length / 3, `expected heavy reduction, got ${simplified.length}`);
});

test('findCorners sees a corner that smoothing has bevelled', () => {
  // A 90 degree corner rendered as two 45 degree turns, which is exactly what
  // smoothing plus simplification produces from a pixel outline.
  const bevelled: Vec[] = [
    { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 61, y: 1 },
    { x: 61, y: 40 }, { x: 60, y: 41 }, { x: 0, y: 41 },
  ];
  // Indices 1-4 form the two bevels; 0 and 5 are ordinary sharp corners.
  const immediate = findCorners(bevelled, Math.PI / 3, 0);
  assert.deepEqual(immediate, [0, 5], 'immediate neighbours see only 45 degrees at a bevel');
  // Measuring across the bevel recovers the full turn at every vertex.
  const windowed = findCorners(bevelled, Math.PI / 3);
  for (const index of [1, 2, 3, 4]) {
    assert.ok(windowed.includes(index), `vertex ${index} of the bevel should be a corner`);
  }
});

test('traceImage keeps a rectangle rectangular', () => {
  // Regression: a missed corner let the curve fit bridge two edges, which
  // inflated the shape well beyond its true bounds.
  const image = makeImage(200, 120, (x, y) =>
    x >= 30 && x < 170 && y >= 40 && y < 90 ? [40, 60, 110, 255] : [240, 238, 230, 255]);
  const result = traceImage(image, { maxColors: 2, minArea: 50, simplifyTolerance: 0.6, fitTolerance: 0.8 });
  const box = result.nodes.find(
    (n) => n.fill.paint.type === 'solid' && n.fill.paint.color.r < 120,
  )!;
  assert.ok(box, 'the rectangle should be traced');
  const bounds = P.bounds(box.path)!;
  assert.ok(Math.abs(bounds.x - 30) < 1.5, `x ${bounds.x}`);
  assert.ok(Math.abs(bounds.y - 40) < 1.5, `y ${bounds.y}`);
  assert.ok(Math.abs(bounds.width - 140) < 1.5, `width ${bounds.width}`);
  assert.ok(Math.abs(bounds.height - 50) < 1.5, `height ${bounds.height}`);
  // The corners must stay square, so the whole box is filled.
  for (const [x, y] of [[32, 42], [167, 42], [167, 87], [32, 87]]) {
    assert.ok(P.containsPoint(box.path, { x, y }), `corner (${x},${y}) should be inside`);
  }
});

test('findCorners flags right angles but not gentle curves', () => {
  const square: Vec[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(findCorners(square, Math.PI / 3).length, 4);
  const circle: Vec[] = [];
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * Math.PI * 2;
    circle.push({ x: Math.cos(t) * 50, y: Math.sin(t) * 50 });
  }
  assert.equal(findCorners(circle, Math.PI / 3).length, 0);
});

test('dedupe removes repeated points', () => {
  assert.equal(dedupe([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }]).length, 2);
});

test('fitCurve reproduces a sampled sine wave within tolerance', () => {
  const points: Vec[] = [];
  for (let i = 0; i <= 100; i++) {
    const x = i;
    points.push({ x, y: Math.sin(x / 15) * 30 });
  }
  const curves = fitCurve(points, 0.5);
  assert.ok(curves.length >= 1 && curves.length < 12, `unexpected curve count ${curves.length}`);
  for (const p of points) {
    const best = Math.min(...curves.map((c) => bezier.nearestT(c, p, 48).distance));
    assert.ok(best <= 0.6, `point off by ${best}`);
  }
});

test('fitCurve on two points produces one straight cubic', () => {
  const curves = fitCurve([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1);
  assert.equal(curves.length, 1);
  assert.deepEqual(curves[0][0], { x: 0, y: 0 });
  assert.deepEqual(curves[0][3], { x: 10, y: 0 });
});

test('fitClosedLoop fits a sampled circle tightly with few curves', () => {
  const points: Vec[] = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    points.push({ x: 100 + Math.cos(t) * 50, y: 100 + Math.sin(t) * 50 });
  }
  const curves = fitClosedLoop(points, 0.4);
  assert.ok(curves.length <= 8, `expected a compact fit, got ${curves.length}`);
  for (const p of points) {
    const best = Math.min(...curves.map((c) => bezier.nearestT(c, p, 48).distance));
    assert.ok(best < 0.5, `point off by ${best}`);
  }
});

test('fitClosedLoop honours corners', () => {
  const square: Vec[] = [];
  const corners = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }];
  for (let side = 0; side < 4; side++) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    for (let i = 0; i < 10; i++) {
      square.push({ x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10 });
    }
  }
  const cornerIndices = findCorners(square, Math.PI / 3);
  assert.equal(cornerIndices.length, 4);
  const curves = fitClosedLoop(square, 0.5, cornerIndices);
  // Each side becomes at least one curve, and the corners stay sharp.
  assert.ok(curves.length >= 4);
  const bounds = curves.map((c) => bezier.bounds(c));
  const minX = Math.min(...bounds.map((b) => b.x));
  const maxX = Math.max(...bounds.map((b) => b.x + b.width));
  assert.ok(minX > -1 && maxX < 61, `corner overshoot: ${minX}..${maxX}`);
});

test('traceImage reproduces two flat colour blocks', () => {
  const image = makeImage(60, 40, (x) => (x < 30 ? [220, 30, 30, 255] : [30, 30, 220, 255]));
  const result = traceImage(image, { maxColors: 4, minArea: 20 });
  assert.equal(result.shapeCount, 2);
  const colors = result.nodes.map((n) => (n.fill.paint.type === 'solid' ? n.fill.paint.color : null));
  assert.ok(colors.some((c) => c && colorDistanceSq(c, { r: 220, g: 30, b: 30, a: 1 }) < 200));
  assert.ok(colors.some((c) => c && colorDistanceSq(c, { r: 30, g: 30, b: 220, a: 1 }) < 200));

  // The shapes must cover the halves they came from.
  const left = result.nodes.find((n) => n.fill.paint.type === 'solid' && n.fill.paint.color.r > 100)!;
  const bounds = P.bounds(left.path)!;
  assert.ok(bounds.width > 25 && bounds.width < 35, `width ${bounds.width}`);
  assert.ok(bounds.height > 38, `height ${bounds.height}`);
});

test('traceImage reproduces a disc as a single rounded shape', () => {
  const image = makeImage(80, 80, (x, y) => {
    const inside = (x - 40) ** 2 + (y - 40) ** 2 <= 30 * 30;
    return inside ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  const result = traceImage(image, { maxColors: 2, minArea: 50 });
  const disc = result.nodes.find((n) => n.fill.paint.type === 'solid' && n.fill.paint.color.r < 80)!;
  assert.ok(disc, 'the dark disc should be traced');
  const bounds = P.bounds(disc.path)!;
  assert.ok(Math.abs(bounds.width - 60) < 3, `width ${bounds.width}`);
  assert.ok(Math.abs(bounds.height - 60) < 3, `height ${bounds.height}`);
  // A curve fit should describe a 60px circle with far fewer than 60 anchors.
  const anchors = disc.path.subpaths[0].anchors.length;
  assert.ok(anchors < 20, `expected a compact curve fit, got ${anchors} anchors`);
  assert.ok(P.containsPoint(disc.path, { x: 40, y: 40 }));
  assert.ok(!P.containsPoint(disc.path, { x: 2, y: 2 }));
});

test('traceImage keeps holes open under the nonzero rule', () => {
  const image = makeImage(80, 80, (x, y) => {
    const r = Math.hypot(x - 40, y - 40);
    return r <= 30 && r >= 15 ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  const result = traceImage(image, { maxColors: 2, minArea: 40 });
  const ring = result.nodes.find((n) => n.fill.paint.type === 'solid' && n.fill.paint.color.r < 80)!;
  assert.ok(ring, 'the ring should be traced');
  assert.ok(ring.path.subpaths.length >= 2, 'the ring needs an outer and an inner subpath');
  assert.ok(P.containsPoint(ring.path, { x: 40, y: 18 }), 'the band should be filled');
  assert.ok(!P.containsPoint(ring.path, { x: 40, y: 40 }), 'the hole must stay empty');
});

test('traceImage drops speckle below the minimum area', () => {
  const image = makeImage(60, 60, (x, y) => {
    if (x === 5 && y === 5) return [255, 0, 0, 255]; // one stray pixel
    if (x > 20 && x < 50 && y > 20 && y < 50) return [255, 0, 0, 255];
    return [255, 255, 255, 255];
  });
  const withSpeckle = traceImage(image, { maxColors: 2, minArea: 1 });
  const withoutSpeckle = traceImage(image, { maxColors: 2, minArea: 20 });
  assert.ok(withSpeckle.shapeCount > withoutSpeckle.shapeCount);
});

test('traceImage skips fully transparent pixels', () => {
  const image = makeImage(40, 40, (x, y) => (x > 10 && x < 30 && y > 10 && y < 30 ? [0, 128, 0, 255] : [0, 0, 0, 0]));
  const result = traceImage(image, { maxColors: 4, minArea: 10 });
  assert.equal(result.shapeCount, 1);
  const bounds = P.bounds(result.nodes[0].path)!;
  assert.ok(Math.abs(bounds.width - 19) <= 2, `width ${bounds.width}`);
});

test('ignoreBackground removes the dominant border colour', () => {
  const image = makeImage(60, 60, (x, y) => (x > 20 && x < 40 && y > 20 && y < 40 ? [200, 0, 0, 255] : [255, 255, 255, 255]));
  const kept = traceImage(image, { maxColors: 2, minArea: 10 });
  const dropped = traceImage(image, { maxColors: 2, minArea: 10, ignoreBackground: true });
  assert.equal(kept.shapeCount, 2);
  assert.equal(dropped.shapeCount, 1);
});

test('the pixel-art preset keeps outlines as exact polygons', () => {
  const image = makeImage(8, 8, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const result = traceImage(image, { maxColors: 2, minArea: 1, curves: false, simplifyTolerance: 0, smoothPasses: 0 });
  assert.ok(result.shapeCount >= 2);
  for (const node of result.nodes) {
    for (const sp of node.path.subpaths) {
      for (const a of sp.anchors) {
        assert.equal(a.point.x, Math.round(a.point.x));
        assert.equal(a.point.y, Math.round(a.point.y));
      }
    }
  }
});

test('trace scale option scales the output', () => {
  const image = makeImage(20, 20, () => [10, 10, 10, 255]);
  const result = traceImage(image, { maxColors: 2, minArea: 4, scale: 2 });
  assert.equal(result.nodes[0].transform.a, 2);
});

test('default options are a sane starting point', () => {
  assert.ok(DEFAULT_TRACE_OPTIONS.maxColors > 1);
  assert.ok(DEFAULT_TRACE_OPTIONS.curves);
});
