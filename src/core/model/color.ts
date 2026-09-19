/** An RGBA colour. Channels are 0-255 integers; `a` is 0-1. */
export type RGBA = { r: number; g: number; b: number; a: number };

export const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });

export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };
export const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export const normalizeColor = (c: RGBA): RGBA => ({
  r: clamp255(c.r),
  g: clamp255(c.g),
  b: clamp255(c.b),
  a: clamp01(c.a),
});

const NAMED: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff',
  maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff',
  green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00', navy: '#000080',
  blue: '#0000ff', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee',
  beige: '#f5f5dc', ivory: '#fffff0', khaki: '#f0e68c', salmon: '#fa8072', crimson: '#dc143c',
  tomato: '#ff6347', coral: '#ff7f50', turquoise: '#40e0d0', lavender: '#e6e6fa',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000', lightblue: '#add8e6',
  skyblue: '#87ceeb', steelblue: '#4682b4', seagreen: '#2e8b57', forestgreen: '#228b22',
  slategray: '#708090', slategrey: '#708090', chocolate: '#d2691e', peru: '#cd853f',
  tan: '#d2b48c', wheat: '#f5deb3', plum: '#dda0dd', orchid: '#da70d6', linen: '#faf0e6',
  snow: '#fffafa', azure: '#f0ffff', mintcream: '#f5fffa', honeydew: '#f0fff0',
};

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: clamp255((r + m) * 255), g: clamp255((g + m) * 255), b: clamp255((b + m) * 255) };
}

/** Parses a CSS colour string. Returns null for `none`, `inherit` and junk. */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  let text = input.trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'inherit' || text === 'currentcolor') return null;
  if (NAMED[text]) text = NAMED[text];

  if (text.startsWith('#')) {
    const hex = text.slice(1);
    const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]),
        g: expand(hex[1]),
        b: expand(hex[2]),
        a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      if (!/^[0-9a-f]+$/.test(hex)) return null;
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const fn = /^(rgba?|hsla?)\s*\(([^)]*)\)$/.exec(text);
  if (fn) {
    const name = fn[1];
    const parts = fn[2].split(/[\s,/]+/).filter((s) => s.length > 0);
    const value = (index: number, scale = 255): number => {
      const raw = parts[index];
      if (raw === undefined) return 0;
      return raw.endsWith('%') ? (parseFloat(raw) / 100) * scale : parseFloat(raw);
    };
    const alpha = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    if (name.startsWith('rgb')) {
      return normalizeColor({ r: value(0), g: value(1), b: value(2), a: alpha });
    }
    const h = parseFloat(parts[0] ?? '0');
    const s = (parts[1]?.endsWith('%') ? parseFloat(parts[1]) / 100 : parseFloat(parts[1] ?? '0'));
    const l = (parts[2]?.endsWith('%') ? parseFloat(parts[2]) / 100 : parseFloat(parts[2] ?? '0'));
    return normalizeColor({ ...hslToRgb(h, clamp01(s), clamp01(l)), a: alpha });
  }
  return null;
}

const hex2 = (v: number): string => clamp255(v).toString(16).padStart(2, '0');

/** `#rrggbb`, dropping the alpha channel. */
export const toHex = (c: RGBA): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** `#rrggbb` or `#rrggbbaa` when the colour is translucent. */
export const toHexA = (c: RGBA): string =>
  c.a >= 1 ? toHex(c) : `${toHex(c)}${hex2(c.a * 255)}`;

export const toCss = (c: RGBA): string =>
  c.a >= 1 ? toHex(c) : `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${Number(c.a.toFixed(4))})`;

export const colorEquals = (a: RGBA, b: RGBA): boolean =>
  a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 1e-6;

/** Perceptual-ish squared distance, weighted for human luminance sensitivity. */
export function colorDistanceSq(a: RGBA, b: RGBA): number {
  const rMean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return (((512 + rMean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rMean) * db * db) >> 8);
}

export const luminance = (c: RGBA): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

export function mixColors(a: RGBA, b: RGBA, t: number): RGBA {
  const k = clamp01(t);
  return normalizeColor({
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  });
}
