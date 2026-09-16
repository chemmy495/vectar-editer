import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from '../src/core/model/document.ts';
import {
  createGroupNode, createLayerNode, createPathNode, createTextNode, cloneNode,
} from '../src/core/model/node.ts';
import { History } from '../src/core/model/history.ts';
import * as ops from '../src/core/model/ops.ts';
import * as query from '../src/core/model/query.ts';
import { rectanglePath } from '../src/core/path/shapes.ts';
import { rect } from '../src/core/geometry/rect.ts';
import { translation, scaling, compose, identity } from '../src/core/geometry/matrix.ts';
import { parseColor, toHexA } from '../src/core/model/color.ts';
import { defaultFill, noStroke } from '../src/core/model/style.ts';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

function docWithRect(x = 0, y = 0, w = 100, h = 50) {
  const doc = createDocument();
  const node = createPathNode(rectanglePath(rect(x, y, w, h)), 'Rect');
  doc.layers[0].children.push(node);
  return { doc, node };
}

test('colors parse and format across notations', () => {
  assert.deepEqual(parseColor('#ff8800'), { r: 255, g: 136, b: 0, a: 1 });
  assert.deepEqual(parseColor('#f80'), { r: 255, g: 136, b: 0, a: 1 });
  assert.deepEqual(parseColor('rgb(255, 136, 0)'), { r: 255, g: 136, b: 0, a: 1 });
  assert.deepEqual(parseColor('red'), { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('none'), null);
  assert.equal(parseColor('bogus'), null);
  assert.equal(toHexA({ r: 255, g: 136, b: 0, a: 1 }), '#ff8800');
});

test('findNode reports parent, index and ancestors', () => {
  const doc = createDocument();
  const group = createGroupNode([createPathNode()], 'G');
  doc.layers[0].children.push(group);
  const child = group.children[0];
  const location = query.findNode(doc, child.id);
  assert.ok(location);
  assert.equal(location!.parent, group);
  assert.equal(location!.index, 0);
  assert.deepEqual(location!.ancestors.map((a) => a.id), [doc.layers[0].id, group.id]);
});

test('worldTransform composes ancestor transforms', () => {
  const doc = createDocument();
  const group = createGroupNode([createPathNode()], 'G');
  group.transform = translation(10, 10);
  doc.layers[0].children.push(group);
  const child = group.children[0];
  child.transform = scaling(2);
  const world = query.worldTransform(doc, child.id);
  assert.deepEqual(world, compose(translation(10, 10), scaling(2)));
});

test('worldBounds accounts for transforms', () => {
  const { doc, node } = docWithRect(0, 0, 100, 50);
  node.transform = translation(20, 30);
  const bounds = query.worldBounds(node, query.parentTransform(doc, node.id));
  assert.deepEqual(bounds, rect(20, 30, 100, 50));
});

test('local bounds include stroke width', () => {
  const { node } = docWithRect(0, 0, 100, 50);
  node.stroke = { ...noStroke(), paint: { type: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }, width: 10 };
  assert.deepEqual(query.localBounds(node), rect(-5, -5, 110, 60));
});

test('hitTest picks the topmost filled shape', () => {
  const doc = createDocument();
  const lower = createPathNode(rectanglePath(rect(0, 0, 100, 100)), 'lower');
  const upper = createPathNode(rectanglePath(rect(50, 50, 100, 100)), 'upper');
  doc.layers[0].children.push(lower, upper);
  assert.equal(query.hitTest(doc, { x: 75, y: 75 })?.id, upper.id);
  assert.equal(query.hitTest(doc, { x: 10, y: 10 })?.id, lower.id);
  assert.equal(query.hitTest(doc, { x: 500, y: 500 }), null);
});

test('hitTest returns the group, not its child, unless deep', () => {
  const doc = createDocument();
  const child = createPathNode(rectanglePath(rect(0, 0, 50, 50)));
  const group = createGroupNode([child], 'G');
  doc.layers[0].children.push(group);
  assert.equal(query.hitTest(doc, { x: 10, y: 10 })?.id, group.id);
  assert.equal(query.hitTest(doc, { x: 10, y: 10 }, { deep: true })?.id, child.id);
});

test('hitTest skips hidden and locked nodes', () => {
  const { doc, node } = docWithRect(0, 0, 100, 100);
  node.visible = false;
  assert.equal(query.hitTest(doc, { x: 10, y: 10 }), null);
  node.visible = true;
  node.locked = true;
  assert.equal(query.hitTest(doc, { x: 10, y: 10 }), null);
});

test('nodesInRect respects strict containment', () => {
  const doc = createDocument();
  const a = createPathNode(rectanglePath(rect(0, 0, 10, 10)), 'a');
  const b = createPathNode(rectanglePath(rect(100, 100, 10, 10)), 'b');
  doc.layers[0].children.push(a, b);
  assert.deepEqual(query.nodesInRect(doc, rect(0, 0, 50, 50)).map((n) => n.name), ['a']);
  assert.deepEqual(query.nodesInRect(doc, rect(5, 5, 200, 200), { strict: false }).map((n) => n.name), ['a', 'b']);
});

test('history undo and redo restore state', () => {
  const doc = createDocument();
  const history = new History();
  const node = createPathNode(rectanglePath(rect(0, 0, 10, 10)));
  history.execute(ops.addNodes(doc, doc.layers[0], [node]));
  assert.equal(doc.layers[0].children.length, 1);
  history.undo();
  assert.equal(doc.layers[0].children.length, 0);
  history.redo();
  assert.equal(doc.layers[0].children.length, 1);
  assert.equal(doc.layers[0].children[0].id, node.id);
});

test('history groups a transaction into one undo step', () => {
  const doc = createDocument();
  const history = new History();
  history.transaction('Add three', () => {
    for (let i = 0; i < 3; i++) history.execute(ops.addNodes(doc, doc.layers[0], [createPathNode()]));
  });
  assert.equal(history.depth(), 1);
  assert.equal(doc.layers[0].children.length, 3);
  history.undo();
  assert.equal(doc.layers[0].children.length, 0);
});

test('a throwing transaction rolls back', () => {
  const doc = createDocument();
  const history = new History();
  assert.throws(() => {
    history.transaction('Broken', () => {
      history.execute(ops.addNodes(doc, doc.layers[0], [createPathNode()]));
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(doc.layers[0].children.length, 0);
  assert.equal(history.depth(), 0);
});

test('removeNodes restores position on undo', () => {
  const doc = createDocument();
  const nodes = [createPathNode(undefined, 'a'), createPathNode(undefined, 'b'), createPathNode(undefined, 'c')];
  doc.layers[0].children.push(...nodes);
  const history = new History();
  history.execute(ops.removeNodes(doc, [nodes[1].id]));
  assert.deepEqual(doc.layers[0].children.map((n) => n.name), ['a', 'c']);
  history.undo();
  assert.deepEqual(doc.layers[0].children.map((n) => n.name), ['a', 'b', 'c']);
});

test('transformNodes moves a node and undoes exactly', () => {
  const { doc, node } = docWithRect(0, 0, 100, 50);
  const history = new History();
  history.execute(ops.transformNodes(doc, [node.id], translation(25, 15)));
  const moved = query.worldBounds(node, query.parentTransform(doc, node.id))!;
  close(moved.x, 25);
  close(moved.y, 15);
  history.undo();
  assert.deepEqual(node.transform, identity());
});

test('transformNodes compensates for the parent transform', () => {
  const doc = createDocument();
  const group = createGroupNode([], 'G');
  group.transform = scaling(2);
  const node = createPathNode(rectanglePath(rect(0, 0, 10, 10)));
  group.children.push(node);
  doc.layers[0].children.push(group);

  const history = new History();
  history.execute(ops.transformNodes(doc, [node.id], translation(20, 0)));
  const world = query.worldBounds(node, query.parentTransform(doc, node.id))!;
  close(world.x, 20); // The drag distance is honoured in document space.
  close(world.width, 20);
});

test('reorderNodes handles front, back and single steps', () => {
  const doc = createDocument();
  const nodes = ['a', 'b', 'c'].map((n) => createPathNode(undefined, n));
  doc.layers[0].children.push(...nodes);
  const names = () => doc.layers[0].children.map((n) => n.name);
  const history = new History();

  history.execute(ops.reorderNodes(doc, [nodes[0].id], 'front'));
  assert.deepEqual(names(), ['b', 'c', 'a']);
  history.undo();
  assert.deepEqual(names(), ['a', 'b', 'c']);

  history.execute(ops.reorderNodes(doc, [nodes[2].id], 'back'));
  assert.deepEqual(names(), ['c', 'a', 'b']);
  history.undo();

  history.execute(ops.reorderNodes(doc, [nodes[0].id], 'forward'));
  assert.deepEqual(names(), ['b', 'a', 'c']);
});

test('group then ungroup keeps world positions', () => {
  const doc = createDocument();
  const a = createPathNode(rectanglePath(rect(0, 0, 10, 10)), 'a');
  const b = createPathNode(rectanglePath(rect(40, 40, 10, 10)), 'b');
  doc.layers[0].children.push(a, b);
  const before = query.selectionBounds(doc, [a.id, b.id])!;

  const history = new History();
  const grouped = ops.groupNodes(doc, [a.id, b.id])!;
  history.execute(grouped.command);
  assert.equal(doc.layers[0].children.length, 1);
  assert.equal(doc.layers[0].children[0].id, grouped.group.id);

  const afterGroup = query.selectionBounds(doc, [grouped.group.id])!;
  close(afterGroup.x, before.x);
  close(afterGroup.width, before.width);

  history.execute(ops.ungroupNodes(doc, [grouped.group.id])!);
  assert.deepEqual(doc.layers[0].children.map((n) => n.name), ['a', 'b']);
  const afterUngroup = query.selectionBounds(doc, [a.id, b.id])!;
  close(afterUngroup.x, before.x);
  close(afterUngroup.width, before.width);
});

test('ungroup applies the group transform to children', () => {
  const doc = createDocument();
  const child = createPathNode(rectanglePath(rect(0, 0, 10, 10)), 'c');
  const group = createGroupNode([child], 'G');
  group.transform = translation(100, 0);
  doc.layers[0].children.push(group);

  new History().execute(ops.ungroupNodes(doc, [group.id])!);
  const bounds = query.worldBounds(child, query.parentTransform(doc, child.id))!;
  close(bounds.x, 100);
});

test('reparentNodes keeps the node in place on screen', () => {
  const doc = createDocument();
  const target = createLayerNode('Layer 2');
  target.transform = translation(50, 0);
  doc.layers.push(target);
  const node = createPathNode(rectanglePath(rect(0, 0, 10, 10)));
  doc.layers[0].children.push(node);
  const before = query.worldBounds(node, query.parentTransform(doc, node.id))!;

  new History().execute(ops.reparentNodes(doc, [node.id], target)!);
  assert.equal(target.children.length, 1);
  assert.equal(doc.layers[0].children.length, 0);
  const after = query.worldBounds(node, query.parentTransform(doc, node.id))!;
  close(after.x, before.x);
});

test('patchNode records the old value', () => {
  const { doc, node } = docWithRect();
  const history = new History();
  history.execute(ops.patchNode(doc, node.id, { name: 'Renamed', opacity: 0.5 })!);
  assert.equal(node.name, 'Renamed');
  assert.equal(node.opacity, 0.5);
  history.undo();
  assert.equal(node.name, 'Rect');
  assert.equal(node.opacity, 1);
});

test('setPath swaps geometry and restores it', () => {
  const { doc, node } = docWithRect(0, 0, 10, 10);
  const history = new History();
  history.execute(ops.setPath(doc, node.id, rectanglePath(rect(0, 0, 99, 99)))!);
  close(query.localBounds(node)!.width, 99);
  history.undo();
  close(query.localBounds(node)!.width, 10);
});

test('layers cannot all be deleted', () => {
  const doc = createDocument();
  assert.equal(ops.removeLayer(doc, doc.layers[0].id), null);
  const added = ops.addLayer(doc);
  new History().execute(added.command);
  assert.equal(doc.layers.length, 2);
  assert.ok(ops.removeLayer(doc, added.layer.id));
});

test('cloneNode with new ids produces an independent copy', () => {
  const original = createGroupNode([createPathNode(rectanglePath(rect(0, 0, 10, 10)))], 'G');
  const copy = cloneNode(original, true);
  assert.notEqual(copy.id, original.id);
  assert.ok(copy.type === 'group' && original.type === 'group');
  const copyChild = (copy as typeof original).children[0];
  assert.notEqual(copyChild.id, original.children[0].id);
  copyChild.name = 'changed';
  assert.equal(original.children[0].name, 'Path');
});

test('text nodes report an estimated box that follows alignment', () => {
  const node = createTextNode('Hello', 0, 0);
  node.fill = defaultFill();
  const start = query.localBounds(node)!;
  node.align = 'middle';
  const middle = query.localBounds(node)!;
  close(middle.x, start.x - start.width / 2);
  assert.ok(start.width > 0 && start.height > 0);
});

test('documentStats counts paths and anchors', () => {
  const { doc } = docWithRect();
  const stats = query.documentStats(doc);
  assert.equal(stats.paths, 1);
  assert.equal(stats.anchors, 4);
});
