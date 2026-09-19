import { compose, scaling } from '../core/geometry/matrix.ts';
import type { Vec } from '../core/geometry/vec.ts';
import { renderDocument } from '../core/render/render.ts';
import * as query from '../core/model/query.ts';
import type { Editor, ToolId } from './editor.ts';
import { drawCanvasFrame, drawGrid, drawNodeEditingOverlay, outlineNode } from './overlay.ts';
import type { Tool } from './tool.ts';

/**
 * The drawing surface. It owns the canvas element, keeps it sized to its
 * container at the device pixel ratio, renders the scene plus overlays, and
 * routes pointer input to the active tool.
 */
export class CanvasView {
  readonly element: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private editor: Editor;
  private tools = new Map<ToolId, Tool>();
  private activeTool: Tool | null = null;
  private frameRequested = false;
  private hoveredNodeId: string | null = null;
  /** Middle-drag or space-drag panning state. */
  private panning: { pointerId: number; lastX: number; lastY: number } | null = null;
  /** Pointer captured for the active tool's gesture, if any. */
  private capturedPointerId: number | null = null;
  private spaceHeld = false;
  /** Images decoded for image nodes, keyed by their href. */
  private imageCache = new Map<string, HTMLImageElement>();

  constructor(editor: Editor, container: HTMLElement) {
    this.editor = editor;
    this.element = document.createElement('canvas');
    this.element.className = 'viewport-canvas';
    this.element.tabIndex = 0;
    container.append(this.element);

    const context = this.element.getContext('2d', { alpha: true });
    if (!context) throw new Error('This system does not provide a 2D canvas context.');
    this.context = context;

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(container);
    this.resize();

    this.attachPointerHandlers();
    this.attachWheelHandler();

    for (const event of ['document', 'selection', 'view', 'tool', 'style'] as const) {
      editor.on(event, () => this.requestRender());
    }
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  /** Switches the active tool, letting the previous one clean up. */
  setActiveTool(id: ToolId): void {
    if (this.activeTool?.id === id) return;
    this.activeTool?.deactivate?.();
    this.activeTool = this.tools.get(id) ?? null;
    this.updateCursor();
    this.requestRender();
  }

  currentTool(): Tool | null {
    return this.activeTool;
  }

  /** Converts a pointer event into document coordinates. */
  toDocumentPoint(event: { clientX: number; clientY: number }): Vec {
    const rect = this.element.getBoundingClientRect();
    return this.editor.viewport.toDocument({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  toScreenPoint(event: { clientX: number; clientY: number }): Vec {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  private resize(): void {
    const parent = this.element.parentElement;
    if (!parent) return;
    const ratio = window.devicePixelRatio || 1;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    this.element.width = Math.max(1, Math.round(width * ratio));
    this.element.height = Math.max(1, Math.round(height * ratio));
    this.editor.viewport.width = width;
    this.editor.viewport.height = height;
    this.requestRender();
  }

  /** Decodes an image node's data URL once and reuses it afterwards. */
  private resolveImage = (href: string): CanvasImageSource | null => {
    const cached = this.imageCache.get(href);
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    const image = new Image();
    image.onload = () => this.requestRender();
    image.src = href;
    this.imageCache.set(href, image);
    return null;
  };

  render(): void {
    const ctx = this.context;
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = this.editor.viewport;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.element.width, this.element.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#26282c';
    ctx.fillRect(0, 0, width, height);

    drawCanvasFrame(ctx, this.editor);

    renderDocument(ctx, this.editor.document, {
      viewTransform: compose(scaling(ratio), this.editor.viewport.matrix()),
      resolveImage: this.resolveImage,
    });

    // Overlays are drawn in CSS pixels so handles keep a constant size.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (this.editor.showGrid) drawGrid(ctx, this.editor);

    if (this.hoveredNodeId && !this.editor.selection.has(this.hoveredNodeId)) {
      const location = query.findNode(this.editor.document, this.hoveredNodeId);
      if (location) {
        outlineNode(
          ctx,
          this.editor,
          location.node,
          compose(query.parentTransform(this.editor.document, location.node.id), location.node.transform),
          'rgba(76, 154, 255, 0.5)',
        );
      }
    }

    if (this.editor.tool === 'node') {
      for (const node of this.editor.selectedNodes()) drawNodeEditingOverlay(ctx, this.editor, node);
    }

    this.activeTool?.drawOverlay?.(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private releaseCapture(pointerId: number): void {
    if (this.element.hasPointerCapture(pointerId)) this.element.releasePointerCapture(pointerId);
  }

  setHovered(id: string | null): void {
    if (this.hoveredNodeId === id) return;
    this.hoveredNodeId = id;
    this.requestRender();
  }

  updateCursor(override?: string): void {
    if (override) {
      this.element.style.cursor = override;
      return;
    }
    if (this.spaceHeld || this.panning) {
      this.element.style.cursor = 'grabbing';
      return;
    }
    this.element.style.cursor = this.activeTool?.cursor ?? 'default';
  }

  setSpaceHeld(held: boolean): void {
    if (this.spaceHeld === held) return;
    this.spaceHeld = held;
    this.updateCursor();
  }

  private attachPointerHandlers(): void {
    this.element.addEventListener('pointerdown', (event) => {
      this.element.focus();
      // Middle button, or space held with any button, pans the view.
      if (event.button === 1 || (this.spaceHeld && event.button === 0)) {
        event.preventDefault();
        this.panning = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
        this.element.setPointerCapture(event.pointerId);
        this.updateCursor();
        return;
      }
      if (event.button !== 0 && event.button !== 2) return;
      // Capture so a drag that leaves the canvas still delivers move and up
      // events here. Without it a gesture released outside the window left its
      // live preview applied but never committed to history.
      this.capturedPointerId = event.pointerId;
      try {
        this.element.setPointerCapture(event.pointerId);
      } catch {
        // Capture can be refused if the pointer is already gone; the gesture
        // still works, it just cannot track outside the element.
        this.capturedPointerId = null;
      }
      this.activeTool?.onPointerDown?.(event, this.toDocumentPoint(event));
    });

    this.element.addEventListener('pointermove', (event) => {
      if (this.panning && this.panning.pointerId === event.pointerId) {
        this.editor.viewport.panBy(event.clientX - this.panning.lastX, event.clientY - this.panning.lastY);
        this.panning.lastX = event.clientX;
        this.panning.lastY = event.clientY;
        this.editor.emit('view');
        return;
      }
      this.activeTool?.onPointerMove?.(event, this.toDocumentPoint(event));
    });

    const endPointer = (event: PointerEvent) => {
      if (this.panning && this.panning.pointerId === event.pointerId) {
        this.panning = null;
        this.releaseCapture(event.pointerId);
        this.updateCursor();
        return;
      }
      if (this.capturedPointerId === event.pointerId) {
        this.capturedPointerId = null;
        this.releaseCapture(event.pointerId);
      }
      this.activeTool?.onPointerUp?.(event, this.toDocumentPoint(event));
    };
    this.element.addEventListener('pointerup', endPointer);
    this.element.addEventListener('pointercancel', endPointer);

    this.element.addEventListener('dblclick', (event) => {
      this.activeTool?.onDoubleClick?.(event, this.toDocumentPoint(event));
    });

    this.element.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  private attachWheelHandler(): void {
    this.element.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const screen = this.toScreenPoint(event);
        if (event.ctrlKey || event.metaKey) {
          // Pinch-zoom gestures arrive as ctrl+wheel.
          this.editor.viewport.zoomAt(screen, Math.exp(-event.deltaY * 0.01));
        } else if (event.shiftKey) {
          this.editor.viewport.panBy(-event.deltaY, 0);
        } else if (event.altKey) {
          this.editor.viewport.zoomAt(screen, event.deltaY < 0 ? 1.1 : 1 / 1.1);
        } else {
          this.editor.viewport.panBy(-event.deltaX, -event.deltaY);
        }
        this.editor.emit('view');
      },
      { passive: false },
    );
  }

  /** Frames the whole page in the window. */
  zoomFit(): void {
    this.editor.viewport.fit(this.editor.documentBounds());
    this.editor.emit('view');
  }

  zoomToSelection(): void {
    const bounds = this.editor.selectionBounds();
    this.editor.viewport.fit(bounds ?? this.editor.documentBounds());
    this.editor.emit('view');
  }
}
