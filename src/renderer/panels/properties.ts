import { button, checkbox, clear, field, h, numberInput, select } from '../dom.ts';
import { compose, decompose, rotation, scaling, translation } from '../../core/geometry/matrix.ts';
import { parseColor, toHex, WHITE, type RGBA } from '../../core/model/color.ts';
import {
  cloneFill, cloneStroke, isFillVisible, isStrokeVisible, paintColor, solidPaint,
  type Fill, type LineCap, type LineJoin, type Stroke,
} from '../../core/model/style.ts';
import * as ops from '../../core/model/ops.ts';
import type { PathNode, TextNode } from '../../core/model/node.ts';
import type { VectarDocument } from '../../core/model/document.ts';
import type { Editor } from '../editor.ts';

/**
 * Colour swatch plus alpha slider, shared by the fill and stroke sections.
 *
 * `onChange` runs live so the canvas updates while dragging, and `onCommit`
 * runs once at the end. The panel only rebuilds itself on commit: rebuilding
 * on every `input` event would destroy the control being dragged.
 */
function colorControl(
  label: string,
  paint: ReturnType<typeof paintColor>,
  hasPaint: boolean,
  onChange: (color: RGBA | null, live: boolean) => void,
): HTMLElement {
  const current = paint ?? { ...WHITE, a: 0 };
  const swatch = h('input', { type: 'color', class: 'color-swatch', value: toHex(current) });
  const alpha = h('input', {
    type: 'range',
    class: 'alpha-slider',
    min: 0,
    max: 100,
    value: String(Math.round(current.a * 100)),
  });

  const build = (): RGBA | null => {
    const parsed = parseColor(swatch.value);
    if (!parsed) return null;
    return { ...parsed, a: Number(alpha.value) / 100 };
  };
  const emit = (live: boolean) => {
    const color = build();
    if (color) onChange(color, live);
  };

  for (const control of [swatch, alpha]) {
    control.addEventListener('input', () => emit(true));
    control.addEventListener('change', () => emit(false));
  }

  const none = button('None', () => onChange(null, false), {
    class: `mini-button${hasPaint ? '' : ' active'}`,
    title: `Remove the ${label.toLowerCase()}`,
  });

  return h('div', { class: 'color-control' }, [
    h('span', { class: 'field-label', text: label }),
    swatch,
    alpha,
    none,
  ]);
}

/**
 * The right-hand inspector. It shows the style and geometry of the selection,
 * or the defaults that new objects will take when nothing is selected.
 */
export function createPropertiesPanel(editor: Editor, container: HTMLElement): void {
  /**
   * A style drag in progress. `before` holds the values from before the drag
   * started, so every live update is derived from those rather than compounding
   * on the previous preview, and the whole drag lands on the undo stack as one
   * step when it ends.
   */
  let pendingStyle: {
    key: 'fill' | 'stroke';
    label: string;
    before: Array<{ node: PathNode | TextNode; value: Fill | Stroke }>;
  } | null = null;

  /**
   * Records an in-progress style drag as a single undo step. Called both when
   * the control reports it is done and when the pointer is released anywhere,
   * so a drag can never be left applied but unrecorded.
   */
  const commitPendingStyle = () => {
    const pending = pendingStyle;
    if (!pending) return;
    pendingStyle = null;

    const key = pending.key;
    const after = pending.before.map((entry) => ({ node: entry.node, value: entry.node[key] }));
    if (after.every((entry, i) => entry.value === pending.before[i].value)) return;

    editor.history.push({
      label: pending.label,
      redo: () => {
        for (const entry of after) (entry.node[key] as Fill | Stroke) = entry.value;
        editor.emit('document');
      },
      undo: () => {
        for (const entry of pending.before) (entry.node[key] as Fill | Stroke) = entry.value;
        editor.emit('document');
      },
    });
  };

  /**
   * Applies a style change to the selection, or to the defaults for new
   * objects when nothing is selected. A `live` call previews without recording;
   * the change is recorded once the drag ends.
   */
  const applyStyle = <T extends Fill | Stroke>(
    key: 'fill' | 'stroke',
    build: (value: T) => T,
    live: boolean,
    label: string,
  ) => {
    // Suspend rebuilds first: editing the default style with nothing selected
    // still emits an event this panel listens to.
    if (live) beginInteraction();

    const nodes = editor.selectedNodes().filter((n): n is PathNode | TextNode => n.type === 'path' || n.type === 'text');
    if (nodes.length === 0) {
      if (key === 'fill') editor.setFill(build(editor.fill as T) as Fill);
      else editor.setStroke(build(editor.stroke as T) as Stroke);
      if (!live) endInteraction();
      return;
    }

    // Starting a different drag commits whatever came before it.
    const sameDrag =
      pendingStyle !== null &&
      pendingStyle.key === key &&
      pendingStyle.before.length === nodes.length &&
      pendingStyle.before.every((entry, i) => entry.node === nodes[i]);
    if (!sameDrag) {
      commitPendingStyle();
      pendingStyle = { key, label, before: nodes.map((node) => ({ node, value: node[key] })) };
    }

    const origin = pendingStyle!.before;
    nodes.forEach((node, i) => {
      (node[key] as Fill | Stroke) = build(origin[i].value as T);
    });
    // A preview is a real change to the document even before it is recorded.
    editor.markDirty();
    editor.emit('document');

    if (!live) {
      commitPendingStyle();
      endInteraction();
    }
  };

  const applyFill = (build: (fill: Fill) => Fill, live = false) =>
    applyStyle<Fill>('fill', build, live, 'Change fill');

  const applyStroke = (build: (stroke: Stroke) => Stroke, live = false) =>
    applyStyle<Stroke>('stroke', build, live, 'Change stroke');

  /** Style shown in the panel: the selection's, or the editor defaults. */
  const currentStyle = (): { fill: Fill; stroke: Stroke } => {
    const styled = editor.selectedNodes().filter((n): n is PathNode | TextNode => n.type === 'path' || n.type === 'text');
    if (styled.length === 0) return { fill: editor.fill, stroke: editor.stroke };
    return { fill: styled[0].fill, stroke: styled[0].stroke };
  };

  const fillSection = (): HTMLElement => {
    const { fill } = currentStyle();
    return h('section', { class: 'panel-section' }, [
      h('h3', { text: 'Fill' }),
      colorControl('Colour', paintColor(fill.paint), isFillVisible(fill), (color, live) => {
        applyFill((current) => ({
          ...cloneFill(current),
          paint: color ? solidPaint(color) : { type: 'none' },
        }), live);
      }),
      field('Rule', select(fill.rule, [
        { value: 'nonzero', label: 'Non-zero' },
        { value: 'evenodd', label: 'Even-odd' },
      ], (rule) => applyFill((current) => ({ ...cloneFill(current), rule })))),
    ]);
  };

  const strokeSection = (): HTMLElement => {
    const { stroke } = currentStyle();
    return h('section', { class: 'panel-section' }, [
      h('h3', { text: 'Stroke' }),
      colorControl('Colour', paintColor(stroke.paint), isStrokeVisible(stroke), (color, live) => {
        applyStroke((current) => ({
          ...cloneStroke(current),
          paint: color ? solidPaint(color) : { type: 'none' },
        }), live);
      }),
      field('Width', numberInput(stroke.width, (width) => {
        applyStroke((current) => ({ ...cloneStroke(current), width: Math.max(0, width) }));
      }, { min: 0, step: 0.5 })),
      field('Cap', select<LineCap>(stroke.cap, [
        { value: 'butt', label: 'Flat' },
        { value: 'round', label: 'Round' },
        { value: 'square', label: 'Square' },
      ], (cap) => applyStroke((current) => ({ ...cloneStroke(current), cap })))),
      field('Join', select<LineJoin>(stroke.join, [
        { value: 'miter', label: 'Miter' },
        { value: 'round', label: 'Round' },
        { value: 'bevel', label: 'Bevel' },
      ], (join) => applyStroke((current) => ({ ...cloneStroke(current), join })))),
      field('Dash', h('input', {
        class: 'text-input',
        value: stroke.dash.join(' '),
        placeholder: 'e.g. 6 3',
        onchange: (event: Event) => {
          const raw = (event.target as HTMLInputElement).value;
          const dash = raw.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
          applyStroke((current) => ({ ...cloneStroke(current), dash }));
        },
      })),
    ]);
  };

  const transformSection = (): HTMLElement | null => {
    const bounds = editor.selectionBounds();
    if (!bounds || editor.selection.size === 0) return null;
    const ids = [...editor.selection];

    /** Moves the selection so its bounding box starts at the given coordinate. */
    const moveTo = (axis: 'x' | 'y', value: number) => {
      const delta = axis === 'x' ? { x: value - bounds.x, y: 0 } : { x: 0, y: value - bounds.y };
      editor.transaction('Move', () => {
        editor.run(ops.transformNodes(editor.document, ids, translation(delta.x, delta.y)));
      });
    };

    /** Scales the selection about its top-left corner to the given size. */
    const resize = (axis: 'width' | 'height', value: number) => {
      if (value <= 0) return;
      const factor = value / Math.max(1e-6, bounds[axis]);
      const matrix = compose(
        translation(bounds.x, bounds.y),
        axis === 'width' ? scaling(factor, 1) : scaling(1, factor),
        translation(-bounds.x, -bounds.y),
      );
      editor.transaction('Resize', () => {
        editor.run(ops.transformNodes(editor.document, ids, matrix));
      });
    };

    const rotate = (degrees: number) => {
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const matrix = compose(
        translation(center.x, center.y),
        rotation((degrees * Math.PI) / 180),
        translation(-center.x, -center.y),
      );
      editor.transaction('Rotate', () => {
        editor.run(ops.transformNodes(editor.document, ids, matrix));
      });
    };

    const flip = (axis: 'x' | 'y') => {
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const matrix = compose(
        translation(center.x, center.y),
        axis === 'x' ? scaling(-1, 1) : scaling(1, -1),
        translation(-center.x, -center.y),
      );
      editor.transaction('Flip', () => {
        editor.run(ops.transformNodes(editor.document, ids, matrix));
      });
    };

    const single = editor.selection.size === 1 ? editor.selectedNodes()[0] : null;
    const angle = single ? (decompose(single.transform).rotation * 180) / Math.PI : 0;

    return h('section', { class: 'panel-section' }, [
      h('h3', { text: 'Transform' }),
      h('div', { class: 'field-grid' }, [
        field('X', numberInput(bounds.x, (v) => moveTo('x', v))),
        field('Y', numberInput(bounds.y, (v) => moveTo('y', v))),
        field('W', numberInput(bounds.width, (v) => resize('width', v), { min: 0 })),
        field('H', numberInput(bounds.height, (v) => resize('height', v), { min: 0 })),
      ]),
      field('Rotate', numberInput(Number(angle.toFixed(2)), (v) => rotate(v - angle), { step: 15 })),
      h('div', { class: 'button-row' }, [
        button('Flip H', () => flip('x'), { class: 'mini-button' }),
        button('Flip V', () => flip('y'), { class: 'mini-button' }),
        button('-90', () => rotate(-90), { class: 'mini-button' }),
        button('+90', () => rotate(90), { class: 'mini-button' }),
      ]),
      field('Opacity', numberInput(Math.round((single?.opacity ?? 1) * 100), (value) => {
        const opacity = Math.max(0, Math.min(1, value / 100));
        editor.transaction('Change opacity', () => {
          editor.run(ops.patchNodes(editor.document, ids, { opacity }, 'Change opacity'));
        });
      }, { min: 0, max: 100 })),
    ]);
  };

  const textSection = (): HTMLElement | null => {
    const nodes = editor.selectedNodes().filter((n): n is TextNode => n.type === 'text');
    if (nodes.length === 0) return null;
    const first = nodes[0];
    const patch = (values: Partial<TextNode>) => {
      editor.transaction('Change text style', () => {
        for (const node of nodes) editor.run(ops.patchNode<TextNode>(editor.document, node.id, values, 'Change text style'));
      });
    };

    return h('section', { class: 'panel-section' }, [
      h('h3', { text: 'Text' }),
      field('Font', h('input', {
        class: 'text-input',
        value: first.fontFamily,
        onchange: (event: Event) => patch({ fontFamily: (event.target as HTMLInputElement).value }),
      })),
      h('div', { class: 'field-grid' }, [
        field('Size', numberInput(first.fontSize, (fontSize) => patch({ fontSize: Math.max(1, fontSize) }), { min: 1 })),
        field('Weight', numberInput(first.fontWeight, (fontWeight) => patch({ fontWeight }), { min: 100, max: 900, step: 100 })),
        field('Spacing', numberInput(first.letterSpacing, (letterSpacing) => patch({ letterSpacing }), { step: 0.5 })),
        field('Line', numberInput(first.lineHeight, (lineHeight) => patch({ lineHeight: Math.max(0.5, lineHeight) }), { step: 0.1 })),
      ]),
      field('Align', select(first.align, [
        { value: 'start', label: 'Left' },
        { value: 'middle', label: 'Centre' },
        { value: 'end', label: 'Right' },
      ], (align) => patch({ align }))),
      checkbox(first.italic, 'Italic', (italic) => patch({ italic })),
    ]);
  };

  const toolSection = (): HTMLElement | null => {
    if (editor.tool === 'brush' || editor.tool === 'pencil') {
      return h('section', { class: 'panel-section' }, [
        h('h3', { text: editor.tool === 'brush' ? 'Brush' : 'Pencil' }),
        field('Width', numberInput(editor.brush.width, (width) => {
          editor.brush = { ...editor.brush, width: Math.max(0.2, width) };
          editor.emit('style');
        }, { min: 0.2, step: 0.5 })),
        field('Smoothing', numberInput(Math.round(editor.brush.smoothing * 100), (value) => {
          editor.brush = { ...editor.brush, smoothing: Math.max(0, Math.min(1, value / 100)) };
          editor.emit('style');
        }, { min: 0, max: 100, step: 5 })),
        field('Detail', numberInput(editor.brush.fitTolerance, (value) => {
          editor.brush = { ...editor.brush, fitTolerance: Math.max(0, value) };
          editor.emit('style');
        }, { min: 0, step: 0.1 })),
        editor.tool === 'brush'
          ? field('Min width %', numberInput(Math.round(editor.brush.minWidthRatio * 100), (value) => {
              editor.brush = { ...editor.brush, minWidthRatio: Math.max(1, Math.min(100, value)) / 100 };
              editor.emit('style');
            }, { min: 1, max: 100, step: 5 }))
          : h('span'),
        editor.tool === 'brush'
          ? checkbox(editor.brush.pressureEnabled, 'Pen pressure', (pressureEnabled) => {
              editor.brush = { ...editor.brush, pressureEnabled };
              editor.emit('style');
            })
          : h('span'),
      ]);
    }

    if (editor.tool === 'rect') {
      return h('section', { class: 'panel-section' }, [
        h('h3', { text: 'Rectangle' }),
        field('Corner radius', numberInput(editor.shapeDefaults.cornerRadius, (cornerRadius) => {
          editor.shapeDefaults = { ...editor.shapeDefaults, cornerRadius: Math.max(0, cornerRadius) };
          editor.emit('style');
        }, { min: 0 })),
      ]);
    }

    if (editor.tool === 'polygon' || editor.tool === 'star') {
      return h('section', { class: 'panel-section' }, [
        h('h3', { text: editor.tool === 'star' ? 'Star' : 'Polygon' }),
        field(editor.tool === 'star' ? 'Points' : 'Sides', numberInput(
          editor.tool === 'star' ? editor.shapeDefaults.starPoints : editor.shapeDefaults.polygonSides,
          (value) => {
            const count = Math.max(3, Math.round(value));
            editor.shapeDefaults = editor.tool === 'star'
              ? { ...editor.shapeDefaults, starPoints: count }
              : { ...editor.shapeDefaults, polygonSides: count };
            editor.emit('style');
          },
          { min: 3 },
        )),
        editor.tool === 'star'
          ? field('Inner %', numberInput(Math.round(editor.shapeDefaults.starInnerRatio * 100), (value) => {
              editor.shapeDefaults = { ...editor.shapeDefaults, starInnerRatio: Math.max(1, Math.min(100, value)) / 100 };
              editor.emit('style');
            }, { min: 1, max: 100, step: 5 }))
          : h('span'),
      ]);
    }

    return null;
  };

  /**
   * Canvas size and background are document state, so they go through history
   * like everything else. Editing them directly used to leave the change
   * un-undoable and, worse, not marked dirty, so it was silently lost on close.
   */
  const setDocumentProperty = <K extends 'width' | 'height' | 'background'>(
    key: K,
    value: VectarDocument[K],
    label: string,
  ) => {
    const doc = editor.document;
    const before = doc[key];
    if (before === value) return;
    editor.history.execute({
      label,
      redo: () => {
        doc[key] = value;
        editor.emit('document', 'view');
      },
      undo: () => {
        doc[key] = before;
        editor.emit('document', 'view');
      },
    });
  };

  const documentSection = (): HTMLElement => {
    const doc = editor.document;
    const background = doc.background ?? { r: 255, g: 255, b: 255, a: 0 };
    const swatch = h('input', { type: 'color', class: 'color-swatch', value: toHex(background) });
    // Preview live while dragging the picker, record once on commit.
    swatch.addEventListener('input', () => {
      const parsed = parseColor(swatch.value);
      if (!parsed) return;
      beginInteraction();
      doc.background = parsed;
      editor.markDirty();
      editor.emit('document');
    });
    swatch.addEventListener('change', () => {
      const parsed = parseColor(swatch.value);
      if (!parsed) return;
      doc.background = background;
      setDocumentProperty('background', parsed, 'Change background');
      endInteraction();
    });

    return h('section', { class: 'panel-section' }, [
      h('h3', { text: 'Document' }),
      h('div', { class: 'field-grid' }, [
        field('W', numberInput(doc.width, (width) => {
          setDocumentProperty('width', Math.max(1, width), 'Resize canvas');
        }, { min: 1 })),
        field('H', numberInput(doc.height, (height) => {
          setDocumentProperty('height', Math.max(1, height), 'Resize canvas');
        }, { min: 1 })),
      ]),
      h('div', { class: 'color-control' }, [
        h('span', { class: 'field-label', text: 'Background' }),
        swatch,
        button('None', () => {
          setDocumentProperty('background', null, 'Clear background');
        }, { class: `mini-button${doc.background ? '' : ' active'}`, title: 'Transparent background' }),
      ]),
      checkbox(editor.showGrid, 'Show grid', (showGrid) => {
        editor.showGrid = showGrid;
        editor.emit('view');
      }),
      checkbox(editor.snapToGrid, 'Snap to grid', (snapToGrid) => {
        editor.snapToGrid = snapToGrid;
        editor.emit('view', 'status');
      }),
      field('Grid size', numberInput(editor.gridSize, (gridSize) => {
        editor.gridSize = Math.max(1, gridSize);
        editor.emit('view');
      }, { min: 1 })),
    ]);
  };

  /** True while a control in this panel owns an in-progress drag. */
  let interacting = false;
  let renderPending = false;

  /** Suspends panel rebuilds so a live drag keeps its control. */
  const beginInteraction = () => {
    interacting = true;
  };

  const endInteraction = () => {
    commitPendingStyle();
    if (!interacting) return;
    interacting = false;
    if (renderPending) {
      renderPending = false;
      render();
    }
  };

  // A pointer released anywhere ends the drag, even if the control's own
  // `change` event never arrives.
  window.addEventListener('pointerup', endInteraction);
  window.addEventListener('pointercancel', endInteraction);

  const render = () => {
    if (interacting) {
      renderPending = true;
      return;
    }
    clear(container);
    const sections: Array<HTMLElement | null> = [
      h('div', { class: 'panel-header' }, [
        h('span', { text: editor.selection.size > 0 ? `${editor.selection.size} selected` : 'Properties' }),
      ]),
      toolSection(),
      fillSection(),
      strokeSection(),
      textSection(),
      transformSection(),
      documentSection(),
    ];
    for (const section of sections) if (section) container.append(section);
  };

  for (const event of ['document', 'selection', 'tool', 'style', 'view'] as const) editor.on(event, render);
  render();
}
