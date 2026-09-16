import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePathData } from '../src/core/path/parse.ts';
import { serializePathData } from '../src/core/path/serialize.ts';
import * as P from '../src/core/path/path.ts';
import * as S from '../src/core/path/shapes.ts';
import { rect } from '../src/core/geometry/rect.ts';
import { rotation, translation, compose } from '../src/core/geometry/matrix.ts';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

test('parses absolute move and line commands', () => {
  const p = parsePathData('M 10 20 L 30 40 L 50 60');
  assert.equal(p.subpaths.length, 1);
  assert.equal(p.subpaths[0].anchors.length, 3);
  assert.deepEqual(p.subpaths[0].anchors[2].point, { x: 50, y: 60 });
  assert.equal(p.subpaths[0].closed, false);
});

test('parses relative commands and implicit line-to repetition', () => {
  const p = parsePathData('m10,10 l10,0 10,0');
  const pts = p.subpaths[0].anchors.map((a) => a.point);
  assert.deepEqual(pts, [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 30, y: 10 }]);
});

test('parses horizontal and vertical shorthands', () => {
  const p = parsePathData('M0 0 H 100 V 50 Z');
  const pts = p.subpaths[0].anchors.map((a) => a.point);
  assert.deepEqual(pts, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
  assert.equal(p.subpaths[0].closed, true);
});

test('parses cubic curves into relative handles', () => {
  const p = parsePathData('M 0 0 C 10 0 20 10 20 20');
  const [a0, a1] = p.subpaths[0].anchors;
  assert.deepEqual(a0.outHandle, { x: 10, y: 0 });
  assert.deepEqual(a1.inHandle, { x: 0, y: -10 });
  assert.deepEqual(a1.point, { x: 20, y: 20 });
});

test('smooth cubic reflects the previous control point', () => {
  const p = parsePathData('M 0 0 C 10 0 20 10 20 20 S 40 30 40 40');
  const a1 = p.subpaths[0].anchors[1];
  assert.deepEqual(a1.outHandle, { x: 0, y: 10 }); // reflection of (20,10) about (20,20)
});

test('quadratic curves are converted to cubics', () => {
  const p = parsePathData('M 0 0 Q 50 100 100 0');
  const [a0, a1] = p.subpaths[0].anchors;
  close(a0.outHandle.x, 100 / 3);
  close(a0.outHandle.y, 200 / 3);
  close(a1.inHandle.x, -100 / 3);
  close(a1.inHandle.y, 200 / 3);
});

test('arc flags parse without separators', () => {
  const p = parsePathData('M 0 0 a 10 10 0 0120 0');
  assert.ok(p.subpaths[0].anchors.length >= 2);
  const last = p.subpaths[0].anchors[p.subpaths[0].anchors.length - 1].point;
  close(last.x, 20, 1e-6);
  close(last.y, 0, 1e-6);
});

test('an arc approximates a half circle', () => {
  const p = parsePathData('M 0 0 A 50 50 0 0 1 100 0');
  const bb = P.bounds(p);
  assert.ok(bb);
  close(bb!.x, 0, 1e-3);
  close(bb!.width, 100, 1e-3);
  close(bb!.height, 50, 0.1);
});

test('multiple subpaths are kept separate', () => {
  const p = parsePathData('M0 0 L10 0 Z M20 0 L30 0 Z');
  assert.equal(p.subpaths.length, 2);
  assert.ok(p.subpaths.every((sp) => sp.closed));
});

test('closing onto the start point does not add a duplicate anchor', () => {
  const p = parsePathData('M0 0 L10 0 L10 10 L0 0 Z');
  assert.equal(p.subpaths[0].anchors.length, 3);
});

test('malformed trailing data is ignored rather than throwing', () => {
  const p = parsePathData('M 0 0 L 10 10 L 20');
  assert.equal(p.subpaths[0].anchors.length, 2);
  assert.deepEqual(parsePathData('').subpaths, []);
  assert.deepEqual(parsePathData('garbage').subpaths, []);
});

test('serialize then parse preserves geometry', () => {
  const original = parsePathData('M 0 0 C 10 0 20 10 20 20 L 40 20 Z M 60 60 L 70 60 L 70 70 Z');
  const round = parsePathData(serializePathData(original));
  assert.equal(round.subpaths.length, original.subpaths.length);
  for (let i = 0; i < original.subpaths.length; i++) {
    assert.equal(round.subpaths[i].closed, original.subpaths[i].closed);
    assert.equal(round.subpaths[i].anchors.length, original.subpaths[i].anchors.length);
    for (let j = 0; j < original.subpaths[i].anchors.length; j++) {
      const a = original.subpaths[i].anchors[j];
      const b = round.subpaths[i].anchors[j];
      close(a.point.x, b.point.x, 1e-3);
      close(a.point.y, b.point.y, 1e-3);
      close(a.inHandle.x, b.inHandle.x, 1e-3);
      close(a.outHandle.y, b.outHandle.y, 1e-3);
    }
  }
});

test('serializer emits L for straight segments and C for curves', () => {
  const d = serializePathData(parsePathData('M0 0 L10 0 C 20 0 30 10 30 20'));
  assert.match(d, /^M 0 0 L 10 0 C 20 0 30 10 30 20$/);
});

test('rectangle path has four corners and the right bounds', () => {
  const p = S.rectanglePath(rect(10, 20, 100, 50));
  assert.equal(p.subpaths[0].anchors.length, 4);
  assert.deepEqual(P.bounds(p), rect(10, 20, 100, 50));
});

test('rounded rectangle stays inside its box', () => {
  const p = S.rectanglePath(rect(0, 0, 100, 50), 10);
  const bb = P.bounds(p)!;
  close(bb.x, 0, 1e-6);
  close(bb.width, 100, 1e-6);
  close(bb.height, 50, 1e-6);
});

test('ellipse fills its bounding box', () => {
  const bb = P.bounds(S.ellipsePath(rect(0, 0, 100, 60)))!;
  close(bb.x, 0, 1e-6);
  close(bb.y, 0, 1e-6);
  close(bb.width, 100, 1e-6);
  close(bb.height, 60, 1e-6);
});

test('containsPoint uses the filled interior', () => {
  const p = S.ellipsePath(rect(0, 0, 100, 100));
  assert.ok(P.containsPoint(p, { x: 50, y: 50 }));
  assert.ok(!P.containsPoint(p, { x: 2, y: 2 }));
  assert.ok(!P.containsPoint(p, { x: 200, y: 50 }));
});

test('transformPath moves points and handles together', () => {
  const p = parsePathData('M 0 0 C 10 0 20 10 20 20');
  const m = compose(translation(5, 5), rotation(Math.PI / 2));
  const t = P.transformPath(p, m);
  const a0 = t.subpaths[0].anchors[0];
  close(a0.point.x, 5);
  close(a0.point.y, 5);
  close(a0.outHandle.x, 0);
  close(a0.outHandle.y, 10);
});

test('insertAnchor keeps the curve shape', () => {
  const p = parsePathData('M 0 0 C 0 100 100 100 100 0');
  const before = P.flattenPath(p, 0.05)[0];
  const sp = P.insertAnchor(p.subpaths[0], 0, 0.5);
  assert.equal(sp.anchors.length, 3);
  const after = P.flattenPath({ subpaths: [sp] }, 0.05)[0];
  const mid = after[Math.floor(after.length / 2)];
  const near = P.nearestPoint(p, mid)!;
  assert.ok(near.distance < 0.1);
  assert.ok(before.length > 2);
});

test('reversePath swaps direction and handles', () => {
  const p = parsePathData('M 0 0 C 10 0 20 10 20 20');
  const r = P.reversePath(p);
  assert.deepEqual(r.subpaths[0].anchors[0].point, { x: 20, y: 20 });
  assert.deepEqual(r.subpaths[0].anchors[0].outHandle, { x: 0, y: -10 });
});

test('star and polygon produce the expected vertex counts', () => {
  assert.equal(S.polygonPath(rect(0, 0, 10, 10), 6).subpaths[0].anchors.length, 6);
  assert.equal(S.starPath(rect(0, 0, 10, 10), 5).subpaths[0].anchors.length, 10);
});
