import { BLACK } from '../../core/model/color.ts';
import { defaultFill, noStroke, type Fill, type Stroke } from '../../core/model/style.ts';
import { DEFAULT_BRUSH, type BrushOptions } from '../../core/brush/stroke.ts';
import type { EventBus } from '../events.ts';

export type ToolId =
  // `node` is the anchor-editing tool; the UI calls anchors "nodes".
  | 'select' | 'node' | 'pen' | 'pencil' | 'brush'
  | 'rect' | 'ellipse' | 'polygon' | 'star' | 'line'
  | 'text' | 'eyedropper' | 'zoom' | 'pan';

export type ShapeDefaults = {
  cornerRadius: number;
  polygonSides: number;
  starPoints: number;
  starInnerRatio: number;
};

/**
 * Which tool is active and the settings new objects are created with. None of
 * this is part of the document; it is the state of the instrument, not the
 * drawing.
 */
export class ToolSettings {
  active: ToolId = 'select';

  fill: Fill = defaultFill(BLACK);
  stroke: Stroke = noStroke();
  brush: BrushOptions = { ...DEFAULT_BRUSH };
  shape: ShapeDefaults = { cornerRadius: 0, polygonSides: 6, starPoints: 5, starInnerRatio: 0.5 };

  private events: EventBus;
  /** Notified when the active tool changes, so listeners can reset state. */
  private onToolChange: Array<(tool: ToolId) => void> = [];

  constructor(events: EventBus) {
    this.events = events;
  }

  /** Registers a callback for tool changes. Used to clear anchor selection. */
  observeTool(listener: (tool: ToolId) => void): void {
    this.onToolChange.push(listener);
  }

  setActive(tool: ToolId): void {
    if (this.active === tool) return;
    this.active = tool;
    for (const listener of this.onToolChange) listener(tool);
    this.events.emit('tool', 'selection');
  }

  setFill(fill: Fill): void {
    this.fill = fill;
    this.events.emit('style');
  }

  setStroke(stroke: Stroke): void {
    this.stroke = stroke;
    this.events.emit('style');
  }

  setBrush(brush: BrushOptions): void {
    this.brush = brush;
    this.events.emit('style');
  }

  setShape(shape: ShapeDefaults): void {
    this.shape = shape;
    this.events.emit('style');
  }
}
