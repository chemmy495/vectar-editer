import { Subscriptions } from './lifecycle.ts';

/** The state changes UI components subscribe to. */
export type EditorEvent =
  | 'document'   // geometry or structure changed
  | 'selection'
  | 'tool'
  | 'view'       // pan/zoom, grid and snapping
  | 'style'      // the default fill/stroke for new objects
  | 'status';    // transient status message

export type EventListener = () => void;

/**
 * The renderer's event bus. The stores publish to it and UI components
 * subscribe; nothing else couples them together.
 */
export class EventBus {
  private listeners = new Map<EditorEvent, Set<EventListener>>();

  /** Subscribes to one event. The returned function removes the listener. */
  on(event: EditorEvent, listener: EventListener): () => void {
    const set = this.listeners.get(event) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  /** Subscribes to several events with one listener. */
  onAny(events: readonly EditorEvent[], listener: EventListener): () => void {
    const offs = events.map((event) => this.on(event, listener));
    return () => offs.forEach((off) => off());
  }

  emit(...events: EditorEvent[]): void {
    for (const event of events) {
      // Copy before iterating: a listener may unsubscribe while running.
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
    }
  }

  /** Subscribes and registers the teardown with a component's collector. */
  bind(subscriptions: Subscriptions, events: readonly EditorEvent[], listener: EventListener): void {
    subscriptions.add(this.onAny(events, listener));
  }

  /** Number of live listeners, for tests. */
  listenerCount(event: EditorEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
