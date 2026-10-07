import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/core/geometry/matrix.ts';
import * as R from '../src/core/geometry/rect.ts';
import * as B from '../src/core/geometry/bezier.ts';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

test('matrix multiply applies right-hand matrix first', () => {
  const m = M.compose(M.translation(10, 0), M.scaling(2));
  const p = M.applyToPoint(m, { x: 3, y: 4 });
  assert.deepEqual(p, { x: 16, y: 8 });
});

test('matrix invert round-trips a point', () => {
  const m = M.compose(M.translation(5, -3), M.rotation(0.7), M.scaling(2, 3));
  const inv = M.invert(m);
  assert.ok(inv);
  const p = { x: 12, y: -4 };
  const back = M.applyToPoint(inv!, M.applyToPoint(m, p));
  close(back.x, p.x);
  close(back.y, p.y);
});

test('parseTransform matches the equivalent composition', () => {
  const parsed = M.parseTransform('translate(10 20) rotate(90) scale(2)');
  const expected = M.compose(M.translation(10, 20), M.rotation(Math.PI / 2), M.scaling(2));
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) close(parsed[key], expected[key]);
});

test('parseTransform handles rotate around a centre', () => {
  const m = M.parseTransform('rotate(180 50 50)');
  const p = M.applyToPoint(m, { x: 50, y: 0 });
  close(p.x, 50);
  close(p.y, 100);
});

test('rect union and intersection', () => {
  const a = R.rect(0, 0, 10, 10);
  const b = R.rect(5, 5, 10, 10);
  assert.deepEqual(R.union(a, b), R.rect(0, 0, 15, 15));
  assert.ok(R.intersects(a, b));
  assert.ok(!R.intersects(a, R.rect(100, 100, 1, 1)));
  assert.ok(R.contains(R.rect(0, 0, 20, 20), a));
});

test('rect transform bounds a rotated rectangle', () => {
  const out = R.transform(R.rect(0, 0, 10, 10), M.rotation(Math.PI / 4));
  close(out.width, Math.sqrt(200), 1e-9);
});

test('bezier bounds are tight, not just the hull', () => {
  const c: B.Cubic = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 100, y: 0 },
  ];
  const bb = B.bounds(c);
  close(bb.x, 0);
  close(bb.width, 100);
  close(bb.y, 0);
  close(bb.height, 75); // The curve peaks at y=75, below the control points.
});

test('bezier split reproduces the original curve', () => {
  const c: B.Cubic = [
    { x: 0, y: 0 },
    { x: 20, y: 80 },
    { x: 80, y: -40 },
    { x: 100, y: 10 },
  ];
  const [l, r] = B.split(c, 0.37);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const original = B.evaluate(c, t * 0.37);
    const half = B.evaluate(l, t);
    close(original.x, half.x, 1e-9);
    close(original.y, half.y, 1e-9);
  }
  const end = B.evaluate(r, 1);
  close(end.x, 100, 1e-9);
});

test('bezier length of a straight line equals the distance', () => {
  const line = B.fromLine({ x: 0, y: 0 }, { x: 30, y: 40 });
  close(B.length(line), 50, 1e-6);
});

test('flatten stays within tolerance of the curve', () => {
  const c: B.Cubic = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 100, y: 0 },
  ];
  const points = B.flatten(c, 0.1);
  assert.ok(points.length > 4);
  const last = points[points.length - 1];
  close(last.x, 100, 1e-9);
  close(last.y, 0, 1e-9);
  for (const p of points) {
    const near = B.nearestT(c, p, 64);
    assert.ok(near.distance < 0.2, `point drifted ${near.distance}`);
  }
});

test('nearestT finds the closest parameter', () => {
  const c = B.fromLine({ x: 0, y: 0 }, { x: 100, y: 0 });
  const hit = B.nearestT(c, { x: 50, y: 10 });
  close(hit.t, 0.5, 1e-3);
  close(hit.distance, 10, 1e-3);
});
