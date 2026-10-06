/**
 * The lifecycle contract every UI component in the renderer follows.
 *
 * Components subscribe to editor state, and a subscription outlives the
 * component unless something releases it. Making `dispose` part of the
 * contract is what lets a panel be closed or rebuilt without leaking the
 * listeners it installed.
 */

/**
 * A UI component with resources to release. Named `Component` rather than
 * `Disposable` because the standard library already has a `Disposable`,
 * meaning a different thing (`Symbol.dispose`).
 */
export type Component = {
  dispose(): void;
};

/**
 * Collects teardown callbacks so a component can release everything it
 * acquired in one call. Disposing twice is safe.
 */
export class Subscriptions implements Component {
  private teardowns: Array<() => void> = [];
  private disposed = false;

  /** Registers a teardown callback, usually the return of `EventBus.on`. */
  add(teardown: () => void): void {
    if (this.disposed) {
      // Acquiring after disposal would leak, so release it immediately.
      teardown();
      return;
    }
    this.teardowns.push(teardown);
  }

  /** Adds a DOM listener and arranges for it to be removed on disposal. */
  addEventListener<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener as EventListener, options);
    this.add(() => target.removeEventListener(type, listener as EventListener, options));
  }

  get size(): number {
    return this.teardowns.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Release in reverse, so teardown mirrors construction.
    for (let i = this.teardowns.length - 1; i >= 0; i--) this.teardowns[i]();
    this.teardowns = [];
  }
}

/** Releases several disposables as one. */
export function disposeAll(items: readonly Component[]): void {
  for (let i = items.length - 1; i >= 0; i--) items[i].dispose();
}
