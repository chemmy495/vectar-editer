import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brushOutlinePoints, brushStrokeToPath, pencilStrokeToPath, resample, smoothStroke,
  DEFAULT_BRUSH, type StrokePoint,
} from '../src/core/brush/stroke.ts';
import { blur } from '../src/core/trace/quantize.ts';
import * as P from '../src/core/path/path.ts';
import { fromPoints } from '../src/core/geometry/rect.ts';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

const line = (count: number, pressure = 1): StrokePoint[] =>
  Array.from({ length: count }, (_, i) => ({ x: i * 10, y: 0, pressure }));

const flat = { ...DEFAULT_BRUSH, width: 8, pressureEnabled: false, speedThinning: 0, smoothing: 0 };

test('round caps bulge past the ends of the stroke', () => {
  // Regression: the cap arc swept inward, folding the outline into a bow tie
  // that rendered as two crossed triangles.
  const outline = brushOutlinePoints(line(3), { ...flat, roundCap: true });
  const box = fromPoints(outline)!;
  close(box.x, -4, 0.01);
  close(box.x + box.width, 24, 0.01);
  close(box.y, -4, 0.01);
  close(box.y + box.height, 4, 0.01);
});

test('a capped stroke fills the area beyond its end points', () => {
  const path = brushStrokeToPath(line(3), { ...flat, roundCap: true, fitTolerance: 0 });
  assert.ok(P.containsPoint(path, { x: 22, y: 0 }), 'the end cap should be filled');
  assert.ok(P.containsPoint(path, { x: -2, y: 0 }), 'the start cap should be filled');
  assert.ok(P.containsPoint(path, { x: 10, y: 0 }), 'the body should be filled');
  assert.ok(!P.containsPoint(path, { x: 10, y: 9 }), 'outside the width should be empty');
  assert.ok(!P.containsPoint(path, { x: 30, y: 0 }), 'past the cap should be empty');
});

test('the outline does not double back on itself', () => {
  // A bow tie shows up as the outline crossing its own centre line.
  const outline = brushOutlinePoints(line(4), { ...flat, roundCap: true });
  const half = outline.length / 2;
  // The first half runs left to right along one side; x must not reverse.
  const forward = outline.slice(0, Math.floor(half) - 8);
  for (let i = 1; i < forward.length; i++) {
    assert.ok(forward[i].x >= forward[i - 1].x - 1e-9, `outline reversed at ${i}`);
  }
});

test('flat caps stop exactly at the end points', () => {
  const box = fromPoints(brushOutlinePoints(line(3), { ...flat, roundCap: false }))!;
  close(box.x, 0, 0.01);
  close(box.x + box.width, 20, 0.01);
});

test('a single tap becomes a dot', () => {
  const outline = brushOutlinePoints([{ x: 5, y: 5, pressure: 1 }], flat);
  const box = fromPoints(outline)!;
  close(box.width, 8, 0.2);
  close(box.height, 8, 0.2);
});

test('pressure varies the stroke width', () => {
  const options = { ...DEFAULT_BRUSH, width: 20, minWidthRatio: 0.1, pressureEnabled: true, speedThinning: 0, smoothing: 0, roundCap: false };
  const light = fromPoints(brushOutlinePoints(line(3, 0.1), options))!;
  const heavy = fromPoints(brushOutlinePoints(line(3, 1), options))!;
  assert.ok(heavy.height > light.height * 2, `light ${light.height} vs heavy ${heavy.height}`);
});

test('brushStrokeToPath produces one closed subpath', () => {
  const path = brushStrokeToPath(line(6), { ...DEFAULT_BRUSH, width: 6 });
  assert.equal(path.subpaths.length, 1);
  assert.equal(path.subpaths[0].closed, true);
  assert.ok(path.subpaths[0].anchors.length >= 4);
});

test('pencilStrokeToPath produces an open centre line', () => {
  const path = pencilStrokeToPath(line(6), 0.5, 1);
  assert.equal(path.subpaths.length, 1);
  assert.equal(path.subpaths[0].closed, false);
  const bounds = P.bounds(path)!;
  close(bounds.width, 50, 1.5);
});

test('resample drops points that are too close together', () => {
  const jittery: StrokePoint[] = Array.from({ length: 20 }, (_, i) => ({ x: i * 0.1, y: 0, pressure: 0.5 }));
  assert.ok(resample(jittery, 1).length < jittery.length);
  assert.equal(resample([], 1).length, 0);
});

test('smoothStroke keeps the ends anchored', () => {
  const points = line(5);
  const smoothed = smoothStroke(points, 0.8);
  assert.deepEqual({ x: smoothed[0].x, y: smoothed[0].y }, { x: 0, y: 0 });
  const last = smoothed[smoothed.length - 1];
  assert.deepEqual({ x: last.x, y: last.y }, { x: 40, y: 0 });
});

test('blur averages premultiplied colour so transparency cannot darken it', () => {
  // Regression: averaging raw channels pulled the invisible black of
  // transparent pixels into opaque neighbours, leaving a dark halo.
  const width = 5;
  const data = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    const o = x * 4;
    const opaque = x < 2;
    data[o] = opaque ? 255 : 0;
    data[o + 3] = opaque ? 255 : 0;
  }
  const out = blur({ width, height: 1, data }, 1);
  assert.equal(out.data[4], 255, 'red must stay pure next to transparency');
  assert.ok(out.data[7] < 255 && out.data[7] > 0, 'alpha should still feather');
  // A fully opaque image is unaffected in colour.
  const solid = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    solid[x * 4] = 120;
    solid[x * 4 + 1] = 180;
    solid[x * 4 + 3] = 255;
  }
  const solidOut = blur({ width, height: 1, data: solid }, 1);
  assert.equal(solidOut.data[4], 120);
  assert.equal(solidOut.data[5], 180);
});
