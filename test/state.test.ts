import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditorContext } from '../src/renderer/state/context.ts';
import { DocumentStore } from '../src/renderer/state/document-store.ts';
import { SelectionStore } from '../src/renderer/state/selection-store.ts';
import { ToolSettings } from '../src/renderer/state/tool-settings.ts';
import { ViewSettings } from '../src/renderer/state/view-settings.ts';
import { EventBus } from '../src/renderer/events.ts';
import { createDocument } from '../src/core/model/document.ts';
import { createPathNode, createGroupNode } from '../src/core/model/node.ts';
import * as commands from '../src/core/model/commands.ts';
import { estimateTextBounds } from '../src/core/model/query.ts';
import { rectanglePath } from '../src/core/path/shapes.ts';
import { rect } from '../src/core/geometry/rect.ts';
import { addNodes, deleteSelection, duplicate, paste } from '../src/renderer/editing.ts';

/**
 * The stores are built without a browser: text measurement is injected, which
 * is what makes this file possible at all.
 */
const makeContext = () => createEditorContext({ measureText: estimateTextBounds });

const withRect = (x = 0, y = 0, w = 10, h = 10, name = 'R') =>
  createPathNode(rectanglePath(rect(x, y, w, h)), name);

test('the stores can be constructed outside a browser', () => {
  const ctx = makeContext();
  assert.ok(ctx.docs instanceof DocumentStore);
  assert.ok(ctx.selection instanceof SelectionStore);
  assert.ok(ctx.tools instanceof ToolSettings);
  assert.ok(ctx.view instanceof ViewSettings);
  assert.equal(ctx.docs.name, 'Untitled');
  assert.equal(ctx.selection.size, 0);
});

test('DocumentStore tracks dirty state across save, undo and redo', () => {
  const ctx = makeContext();
  assert.equal(ctx.docs.dirty, false);

  ctx.docs.run(commands.addNodes(ctx.docs.document, ctx.docs.document.layers[0], [withRect()]));
  assert.equal(ctx.docs.dirty, true);

  ctx.docs.markSaved('/tmp/a.vectar');
  assert.equal(ctx.docs.dirty, false);
  assert.equal(ctx.docs.filePath, '/tmp/a.vectar');

  ctx.docs.undo();
  assert.equal(ctx.docs.dirty, true, 'undoing past the saved state is a change');
  ctx.docs.redo();
  assert.equal(ctx.docs.dirty, false, 'redoing back to it is not');
});

test('DocumentStore.load resets history and dependent state', () => {
  const ctx = makeContext();
  const node = withRect();
  ctx.docs.run(commands.addNodes(ctx.docs.document, ctx.docs.document.layers[0], [node]));
  ctx.selection.set([node.id]);
  ctx.docs.markDirty();

  ctx.docs.load(createDocument(100, 100, 'Fresh'), null);
  assert.equal(ctx.docs.name, 'Fresh');
  assert.equal(ctx.docs.dirty, false);
  assert.equal(ctx.docs.history.depth(), 0);
  assert.equal(ctx.selection.size, 0, 'a new document invalidates the old selection');
});

test('DocumentStore emits document on every history change', () => {
  const events = new EventBus();
  const docs = new DocumentStore(events);
  let count = 0;
  events.on('document', () => { count += 1; });
  docs.run(commands.addNodes(docs.document, docs.document.layers[0], [withRect()]));
  docs.undo();
  docs.redo();
  assert.equal(count, 3);
});

test('SelectionStore reads the document but never writes to it', () => {
  const ctx = makeContext();
  const a = withRect(0, 0, 10, 10, 'a');
  const b = withRect(40, 40, 10, 10, 'b');
  ctx.docs.document.layers[0].children.push(a, b);

  ctx.selection.set([a.id, b.id]);
  assert.equal(ctx.selection.size, 2);
  assert.deepEqual(ctx.selection.nodes().map((n) => n.name), ['a', 'b']);
  assert.deepEqual(ctx.selection.bounds(), rect(0, 0, 50, 50));

  ctx.selection.toggle(a.id);
  assert.equal(ctx.selection.size, 1);
  assert.ok(ctx.selection.has(b.id));

  // Reading the selection left the document untouched.
  assert.equal(ctx.docs.document.layers[0].children.length, 2);
  assert.equal(ctx.docs.dirty, false);
});

test('selection is pruned when undo removes the selected objects', () => {
  const ctx = makeContext();
  const node = withRect();
  ctx.docs.run(commands.addNodes(ctx.docs.document, ctx.docs.document.layers[0], [node]));
  ctx.selection.set([node.id]);
  assert.equal(ctx.selection.size, 1);

  ctx.docs.undo();
  assert.equal(ctx.selection.size, 0, 'an object that no longer exists cannot stay selected');
});

test('selectAll skips hidden and locked objects', () => {
  const ctx = makeContext();
  const visible = withRect(0, 0, 10, 10, 'visible');
  const hidden = withRect(0, 0, 10, 10, 'hidden');
  const locked = withRect(0, 0, 10, 10, 'locked');
  hidden.visible = false;
  locked.locked = true;
  ctx.docs.document.layers[0].children.push(visible, hidden, locked);

  ctx.selection.selectAll();
  assert.deepEqual(ctx.selection.nodes().map((n) => n.name), ['visible']);
});

test('insertionParent follows the selection into a group', () => {
  const ctx = makeContext();
  const child = withRect(0, 0, 10, 10, 'child');
  const group = createGroupNode([child], 'G');
  ctx.docs.document.layers[0].children.push(group);

  assert.equal(ctx.selection.insertionParent().id, ctx.docs.document.layers[0].id);
  ctx.selection.set([child.id]);
  assert.equal(ctx.selection.insertionParent().id, group.id, 'drawing inside a group stays inside it');
});

test('singlePath narrows to a path node', () => {
  const ctx = makeContext();
  const path = withRect();
  const group = createGroupNode([], 'G');
  ctx.docs.document.layers[0].children.push(path, group);

  ctx.selection.set([path.id]);
  assert.equal(ctx.selection.singlePath()?.id, path.id);
  ctx.selection.set([group.id]);
  assert.equal(ctx.selection.singlePath(), null);
  ctx.selection.set([path.id, group.id]);
  assert.equal(ctx.selection.singlePath(), null, 'two objects are not a single path');
});

test('leaving the anchor tool clears the anchors it had selected', () => {
  const ctx = makeContext();
  const path = withRect();
  ctx.docs.document.layers[0].children.push(path);
  ctx.selection.set([path.id]);
  ctx.tools.setActive('node');
  ctx.selection.setAnchors(path.id, new Set(['0:0']));
  assert.ok(ctx.selection.anchors);

  ctx.tools.setActive('select');
  assert.equal(ctx.selection.anchors, null);
});

test('ToolSettings announces style changes', () => {
  const events = new EventBus();
  const tools = new ToolSettings(events);
  let styles = 0;
  let toolChanges = 0;
  events.on('style', () => { styles += 1; });
  events.on('tool', () => { toolChanges += 1; });

  tools.setFill({ paint: { type: 'none' }, rule: 'nonzero' });
  tools.setBrush({ ...tools.brush, width: 12 });
  assert.equal(styles, 2);

  tools.setActive('pen');
  tools.setActive('pen'); // no change, no event
  assert.equal(toolChanges, 1);
  assert.equal(tools.active, 'pen');
});

test('ViewSettings snaps only when snapping is on', () => {
  const events = new EventBus();
  const view = new ViewSettings(events);
  view.gridSize = 10;
  assert.deepEqual(view.snap({ x: 13, y: 27 }), { x: 13, y: 27 });

  view.setSnapToGrid(true);
  assert.deepEqual(view.snap({ x: 13, y: 27 }), { x: 10, y: 30 });

  let views = 0;
  events.on('view', () => { views += 1; });
  view.toggleGrid();
  view.setGridSize(20);
  view.setGridSize(20); // no change, no event
  assert.equal(views, 2);
});

test('clipboard copies detached nodes', () => {
  const ctx = makeContext();
  const node = withRect(0, 0, 10, 10, 'original');
  ctx.docs.document.layers[0].children.push(node);
  ctx.selection.set([node.id]);

  ctx.clipboard.copy();
  assert.equal(ctx.clipboard.isEmpty, false);
  // Editing the original afterwards must not change what will be pasted.
  node.name = 'changed';
  assert.equal(ctx.clipboard.take()[0].name, 'original');
});

test('cut removes the objects and clears the selection', () => {
  const ctx = makeContext();
  const node = withRect();
  ctx.docs.run(commands.addNodes(ctx.docs.document, ctx.docs.document.layers[0], [node]));
  ctx.selection.set([node.id]);

  ctx.clipboard.cut();
  assert.equal(ctx.docs.document.layers[0].children.length, 0);
  assert.equal(ctx.selection.size, 0);

  ctx.docs.undo();
  assert.equal(ctx.docs.document.layers[0].children.length, 1, 'cut is undoable');
});

test('paste and duplicate add independent copies', () => {
  const ctx = makeContext();
  const node = withRect(0, 0, 10, 10, 'source');
  addNodes(ctx, [node], 'Add');
  ctx.clipboard.copy();

  paste(ctx);
  assert.equal(ctx.docs.document.layers[0].children.length, 2);
  const pasted = ctx.selection.nodes()[0];
  assert.notEqual(pasted.id, node.id, 'a pasted copy gets its own id');

  ctx.selection.set([node.id]);
  duplicate(ctx);
  assert.equal(ctx.docs.document.layers[0].children.length, 3);
  // Duplicates are offset so they are visibly distinct.
  assert.equal(ctx.selection.nodes()[0].transform.e, node.transform.e + 10);
});

test('deleteSelection removes everything selected in one undo step', () => {
  const ctx = makeContext();
  const nodes = ['a', 'b', 'c'].map((n) => withRect(0, 0, 10, 10, n));
  addNodes(ctx, nodes, 'Add');
  ctx.selection.set(nodes.slice(0, 2).map((n) => n.id));

  const depth = ctx.docs.history.depth();
  deleteSelection(ctx);
  assert.deepEqual(ctx.docs.document.layers[0].children.map((n) => n.name), ['c']);
  assert.equal(ctx.docs.history.depth(), depth + 1, 'one step, not one per object');

  ctx.docs.undo();
  assert.deepEqual(ctx.docs.document.layers[0].children.map((n) => n.name), ['a', 'b', 'c']);
});

test('addNodes puts objects where new ones belong and selects them', () => {
  const ctx = makeContext();
  const node = withRect();
  addNodes(ctx, [node], 'Add object');
  assert.equal(ctx.docs.document.layers[0].children[0].id, node.id);
  assert.deepEqual([...ctx.selection.ids], [node.id]);
  assert.equal(ctx.docs.dirty, true);
});
