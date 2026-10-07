import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Subscriptions, disposeAll, type Component } from '../src/renderer/lifecycle.ts';
import { EventBus } from '../src/renderer/events.ts';

test('EventBus delivers to every listener of an event', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on('document', () => seen.push('a'));
  bus.on('document', () => seen.push('b'));
  bus.on('selection', () => seen.push('c'));
  bus.emit('document');
  assert.deepEqual(seen, ['a', 'b']);
  bus.emit('selection', 'document');
  assert.deepEqual(seen, ['a', 'b', 'c', 'a', 'b']);
});

test('EventBus.on returns a working unsubscribe', () => {
  const bus = new EventBus();
  let count = 0;
  const off = bus.on('view', () => { count += 1; });
  bus.emit('view');
  off();
  bus.emit('view');
  assert.equal(count, 1);
  assert.equal(bus.listenerCount('view'), 0);
});

test('onAny subscribes and unsubscribes across several events', () => {
  const bus = new EventBus();
  let count = 0;
  const off = bus.onAny(['document', 'selection'], () => { count += 1; });
  bus.emit('document');
  bus.emit('selection');
  assert.equal(count, 2);
  off();
  bus.emit('document', 'selection');
  assert.equal(count, 2);
  assert.equal(bus.listenerCount('document'), 0);
  assert.equal(bus.listenerCount('selection'), 0);
});

test('a listener may unsubscribe while the event is being delivered', () => {
  // Emitting iterates a copy, so removing during delivery cannot skip anyone.
  const bus = new EventBus();
  const seen: string[] = [];
  const off = bus.on('tool', () => {
    seen.push('first');
    off();
  });
  bus.on('tool', () => seen.push('second'));
  bus.emit('tool');
  assert.deepEqual(seen, ['first', 'second']);
  bus.emit('tool');
  assert.deepEqual(seen, ['first', 'second', 'second']);
});

test('Subscriptions releases everything it collected, in reverse', () => {
  const subscriptions = new Subscriptions();
  const released: number[] = [];
  subscriptions.add(() => released.push(1));
  subscriptions.add(() => released.push(2));
  subscriptions.add(() => released.push(3));
  assert.equal(subscriptions.size, 3);
  subscriptions.dispose();
  assert.deepEqual(released, [3, 2, 1]);
});

test('disposing twice is safe and does not release twice', () => {
  const subscriptions = new Subscriptions();
  let count = 0;
  subscriptions.add(() => { count += 1; });
  subscriptions.dispose();
  subscriptions.dispose();
  assert.equal(count, 1);
});

test('adding after disposal releases immediately rather than leaking', () => {
  const subscriptions = new Subscriptions();
  subscriptions.dispose();
  let released = false;
  subscriptions.add(() => { released = true; });
  assert.ok(released, 'a late subscription must not be retained');
  assert.equal(subscriptions.size, 0);
});

test('bind ties a subscription to a component collector', () => {
  const bus = new EventBus();
  const subscriptions = new Subscriptions();
  let count = 0;
  bus.bind(subscriptions, ['document', 'view'], () => { count += 1; });
  bus.emit('document');
  assert.equal(count, 1);

  subscriptions.dispose();
  bus.emit('document', 'view');
  assert.equal(count, 1, 'disposal must stop delivery');
  assert.equal(bus.listenerCount('document'), 0);
  assert.equal(bus.listenerCount('view'), 0);
});

test('a component that follows the contract leaves no listeners behind', () => {
  // This is the invariant the contract exists for: build a component, use it,
  // dispose it, and the bus is back to where it started.
  const bus = new EventBus();
  const buildPanel = (): Component => {
    const subscriptions = new Subscriptions();
    bus.bind(subscriptions, ['document', 'selection', 'style'], () => {});
    return { dispose: () => subscriptions.dispose() };
  };

  const before = (['document', 'selection', 'style'] as const).map((e) => bus.listenerCount(e));
  const panels = [buildPanel(), buildPanel(), buildPanel()];
  assert.deepEqual((['document', 'selection', 'style'] as const).map((e) => bus.listenerCount(e)), [3, 3, 3]);

  disposeAll(panels);
  assert.deepEqual((['document', 'selection', 'style'] as const).map((e) => bus.listenerCount(e)), before);
});
