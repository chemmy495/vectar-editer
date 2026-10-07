import { applyToPoint, invert, type Matrix } from '../core/geometry/matrix.ts';
import type { Rect } from '../core/geometry/rect.ts';
import type { Vec } from '../core/geometry/vec.ts';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

/**
 * Maps between document coordinates and canvas pixels. The transform is
 * always a uniform scale plus a translation, so zooming never skews the view.
 */
export class Viewport {
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  /** Canvas size in CSS pixels. */
  width = 0;
  height = 0;

  matrix(): Matrix {
    return { a: this.scale, b: 0, c: 0, d: this.scale, e: this.offsetX, f: this.offsetY };
  }

  toScreen(point: Vec): Vec {
    return { x: point.x * this.scale + this.offsetX, y: point.y * this.scale + this.offsetY };
  }

  toDocument(point: Vec): Vec {
    return { x: (point.x - this.offsetX) / this.scale, y: (point.y - this.offsetY) / this.scale };
  }

  /** Converts a screen-space distance into document units. */
  toDocumentLength(pixels: number): number {
    return pixels / this.scale;
  }

  panBy(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  /** Zooms by `factor`, keeping the document point under `anchor` fixed. */
  zoomAt(anchor: Vec, factor: number): void {
    const before = this.toDocument(anchor);
    this.scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.scale * factor));
    const after = this.toDocument(anchor);
    this.offsetX += (after.x - before.x) * this.scale;
    this.offsetY += (after.y - before.y) * this.scale;
  }

  setZoom(scale: number, anchor?: Vec): void {
    const target = anchor ?? { x: this.width / 2, y: this.height / 2 };
    this.zoomAt(target, Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale)) / this.scale);
  }

  /** Frames `area` in the viewport with a margin, clamped to the zoom range. */
  fit(area: Rect, padding = 40): void {
    if (area.width <= 0 || area.height <= 0 || this.width <= 0 || this.height <= 0) return;
    const scaleX = (this.width - padding * 2) / area.width;
    const scaleY = (this.height - padding * 2) / area.height;
    this.scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));
    this.offsetX = this.width / 2 - (area.x + area.width / 2) * this.scale;
    this.offsetY = this.height / 2 - (area.y + area.height / 2) * this.scale;
  }

  /** The document-space rectangle currently visible. */
  visibleArea(): Rect {
    const topLeft = this.toDocument({ x: 0, y: 0 });
    const bottomRight = this.toDocument({ x: this.width, y: this.height });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  /** Inverse transform, or the identity if the scale has collapsed. */
  inverse(): Matrix {
    return invert(this.matrix()) ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }

  /** Applies an arbitrary matrix to a point, for overlay maths. */
  static apply(matrix: Matrix, point: Vec): Vec {
    return applyToPoint(matrix, point);
  }
}
