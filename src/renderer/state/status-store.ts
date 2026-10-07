import type { EventBus } from '../events.ts';

/** The transient message shown in the status bar. */
export class StatusStore {
  message = '';

  private events: EventBus;

  constructor(events: EventBus) {
    this.events = events;
  }

  set(message: string): void {
    this.message = message;
    this.events.emit('status');
  }

  clear(): void {
    this.set('');
  }
}
