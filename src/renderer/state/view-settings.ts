import type { Vec } from '../../core/geometry/vec.ts';
import { Viewport } from '../viewport.ts';
import type { EventBus } from '../events.ts';

/**
 * How the document is shown: the pan/zoom transform plus the drawing aids.
 * Nothing here affects what is saved.
 */
export class ViewSettings {
  readonly viewport = new Viewport();

  showGrid = false;
  snapToGrid = false;
  showRulers = true;
  gridSize = 20;

  private events: EventBus;

  constructor(events: EventBus) {
    this.events = events;
  }

  /** Announces that the view changed, after a pan, zoom or toggle. */
  changed(): void {
    this.events.emit('view');
  }

  setShowGrid(visible: boolean): void {
    if (this.showGrid === visible) return;
    this.showGrid = visible;
    this.changed();
  }

  toggleGrid(): void {
    this.setShowGrid(!this.showGrid);
  }

  setSnapToGrid(enabled: boolean): void {
    if (this.snapToGrid === enabled) return;
    this.snapToGrid = enabled;
    this.events.emit('view', 'status');
  }

  toggleSnap(): void {
    this.setSnapToGrid(!this.snapToGrid);
  }

  toggleRulers(): void {
    this.showRulers = !this.showRulers;
    this.changed();
  }

  setGridSize(size: number): void {
    const next = Math.max(1, size);
    if (this.gridSize === next) return;
    this.gridSize = next;
    this.changed();
  }

  /** Rounds a document point to the grid, when snapping is on. */
  snap(point: Vec): Vec {
    if (!this.snapToGrid || this.gridSize <= 0) return point;
    return {
      x: Math.round(point.x / this.gridSize) * this.gridSize,
      y: Math.round(point.y / this.gridSize) * this.gridSize,
    };
  }

  /** Converts a screen distance into document units. */
  toDocumentLength(pixels: number): number {
    return this.viewport.toDocumentLength(pixels);
  }

  zoomBy(factor: number, anchor?: Vec): void {
    this.viewport.zoomAt(anchor ?? { x: this.viewport.width / 2, y: this.viewport.height / 2 }, factor);
    this.changed();
  }

  setZoom(scale: number): void {
    this.viewport.setZoom(scale);
    this.changed();
  }
}
