import { estimateTextBounds, type TextMeasurer } from '../../core/model/query.ts';

/**
 * Text metrics from a scratch canvas.
 *
 * This is the renderer's one piece of unavoidable DOM dependence in the state
 * layer, so it is a separate service that the stores receive. That keeps them
 * constructible, and testable, without a browser.
 */
export function createCanvasTextMeasurer(): TextMeasurer {
  let context: CanvasRenderingContext2D | null | undefined;

  return (node) => {
    if (context === undefined) context = document.createElement('canvas').getContext('2d');
    if (!context) return estimateTextBounds(node);

    const style = node.italic ? 'italic ' : '';
    context.font = `${style}${node.fontWeight} ${node.fontSize}px ${node.fontFamily}, sans-serif`;
    const lines = node.text.split('\n');
    let width = 0;
    for (const line of lines) {
      const measured = context.measureText(line).width + Math.max(0, line.length - 1) * node.letterSpacing;
      width = Math.max(width, measured);
    }
    const ascent = node.fontSize * 0.8;
    const height = (lines.length - 1) * node.fontSize * node.lineHeight + node.fontSize;
    const offsetX = node.align === 'middle' ? -width / 2 : node.align === 'end' ? -width : 0;
    return { x: node.x + offsetX, y: node.y - ascent, width, height };
  };
}
