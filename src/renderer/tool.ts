import type { Vec } from '../core/geometry/vec.ts';
import type { ToolId } from './editor.ts';

/** A tool receives pointer input in document coordinates and may draw a preview. */
export type Tool = {
  id: ToolId;
  /** CSS cursor while the tool is active. */
  cursor: string;
  onPointerDown?(event: PointerEvent, point: Vec): void;
  onPointerMove?(event: PointerEvent, point: Vec): void;
  onPointerUp?(event: PointerEvent, point: Vec): void;
  onDoubleClick?(event: MouseEvent, point: Vec): void;
  /** Return true to stop the key from reaching the global shortcut handler. */
  onKeyDown?(event: KeyboardEvent): boolean;
  /** Overlay drawn in CSS-pixel screen space, on top of the scene. */
  drawOverlay?(ctx: CanvasRenderingContext2D): void;
  /** Called when the tool loses focus; commit or abandon in-progress work. */
  deactivate?(): void;
};
