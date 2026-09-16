import type { RGBA } from '../model/color.ts';

/** A decoded raster image: row-major RGBA bytes. */
export type ImageData8 = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type QuantizeResult = {
  palette: RGBA[];
  /**
   * One palette index per pixel, or `-1` where the source pixel was more
   * transparent than the alpha threshold.
   */
  indices: Int32Array;
};

type Box = {
  /** Offsets into the sample arrays that belong to this box. */
  from: number;
  to: number;
  rMin: number; rMax: number;
  gMin: number; gMax: number;
  bMin: number; bMax: number;
};

const channelRange = (box: Box): { channel: 0 | 1 | 2; size: number } => {
  const dr = box.rMax - box.rMin;
  const dg = box.gMax - box.gMin;
  const db = box.bMax - box.bMin;
  // Weighted by luminance sensitivity so splits follow perceived differences.
  const wr = dr * 1.0;
  const wg = dg * 1.2;
  const wb = db * 0.8;
  if (wg >= wr && wg >= wb) return { channel: 1, size: dg };
  if (wr >= wb) return { channel: 0, size: dr };
  return { channel: 2, size: db };
};

function boundsOf(samples: Uint8Array, from: number, to: number): Omit<Box, 'from' | 'to'> {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (let i = from; i < to; i++) {
    const r = samples[i * 3];
    const g = samples[i * 3 + 1];
    const b = samples[i * 3 + 2];
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return { rMin, rMax, gMin, gMax, bMin, bMax };
}

/** Sorts samples in `[from, to)` by one channel, using an in-place quicksort. */
function sortRange(samples: Uint8Array, from: number, to: number, channel: 0 | 1 | 2): void {
  const count = to - from;
  if (count <= 1) return;
  // Counting sort: channel values are bytes, so this beats a comparison sort.
  const counts = new Int32Array(256);
  for (let i = from; i < to; i++) counts[samples[i * 3 + channel]] += 1;
  const offsets = new Int32Array(256);
  let running = from;
  for (let v = 0; v < 256; v++) {
    offsets[v] = running;
    running += counts[v];
  }
  const copy = samples.slice(from * 3, to * 3);
  for (let i = 0; i < count; i++) {
    const value = copy[i * 3 + channel];
    const target = offsets[value]++;
    samples[target * 3] = copy[i * 3];
    samples[target * 3 + 1] = copy[i * 3 + 1];
    samples[target * 3 + 2] = copy[i * 3 + 2];
  }
}

/**
 * Median-cut colour quantization followed by a few k-means refinement passes.
 * `maxColors` is an upper bound: flat images naturally yield fewer.
 */
export function quantize(
  image: ImageData8,
  maxColors: number,
  options: { alphaThreshold?: number; refineIterations?: number; sampleLimit?: number } = {},
): QuantizeResult {
  const alphaThreshold = options.alphaThreshold ?? 128;
  const refineIterations = options.refineIterations ?? 2;
  const sampleLimit = options.sampleLimit ?? 200_000;
  const pixelCount = image.width * image.height;
  const colors = Math.max(1, Math.min(256, Math.round(maxColors)));

  // Collect opaque pixels, subsampling large images to keep the sort cheap.
  const step = Math.max(1, Math.ceil(pixelCount / sampleLimit));
  let sampleCount = 0;
  for (let i = 0; i < pixelCount; i += step) {
    if (image.data[i * 4 + 3] >= alphaThreshold) sampleCount += 1;
  }
  if (sampleCount === 0) {
    return { palette: [], indices: new Int32Array(pixelCount).fill(-1) };
  }
  const samples = new Uint8Array(sampleCount * 3);
  let write = 0;
  for (let i = 0; i < pixelCount; i += step) {
    if (image.data[i * 4 + 3] < alphaThreshold) continue;
    samples[write * 3] = image.data[i * 4];
    samples[write * 3 + 1] = image.data[i * 4 + 1];
    samples[write * 3 + 2] = image.data[i * 4 + 2];
    write += 1;
  }

  // Median cut: repeatedly split the box with the widest colour spread.
  const boxes: Box[] = [{ from: 0, to: sampleCount, ...boundsOf(samples, 0, sampleCount) }];
  while (boxes.length < colors) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.to - box.from < 2) continue;
      const { size } = channelRange(box);
      const score = size * Math.log2(box.to - box.from + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const box = boxes[bestIndex];
    const { channel } = channelRange(box);
    sortRange(samples, box.from, box.to, channel);
    const mid = box.from + ((box.to - box.from) >> 1);
    const left: Box = { from: box.from, to: mid, ...boundsOf(samples, box.from, mid) };
    const right: Box = { from: mid, to: box.to, ...boundsOf(samples, mid, box.to) };
    boxes.splice(bestIndex, 1, left, right);
  }

  let centroids = boxes.map((box) => {
    let r = 0, g = 0, b = 0;
    const count = Math.max(1, box.to - box.from);
    for (let i = box.from; i < box.to; i++) {
      r += samples[i * 3];
      g += samples[i * 3 + 1];
      b += samples[i * 3 + 2];
    }
    return { r: r / count, g: g / count, b: b / count };
  });

  // k-means over the samples sharpens the palette that median cut roughed out.
  for (let iteration = 0; iteration < refineIterations; iteration++) {
    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (let i = 0; i < sampleCount; i++) {
      const r = samples[i * 3];
      const g = samples[i * 3 + 1];
      const b = samples[i * 3 + 2];
      let best = 0;
      let bestDist = Infinity;
      for (let k = 0; k < centroids.length; k++) {
        const c = centroids[k];
        const d = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      }
      const acc = sums[best];
      acc.r += r;
      acc.g += g;
      acc.b += b;
      acc.n += 1;
    }
    centroids = centroids.map((c, k) => {
      const acc = sums[k];
      return acc.n === 0 ? c : { r: acc.r / acc.n, g: acc.g / acc.n, b: acc.b / acc.n };
    });
  }

  const palette: RGBA[] = centroids.map((c) => ({
    r: Math.round(c.r),
    g: Math.round(c.g),
    b: Math.round(c.b),
    a: 1,
  }));

  // Assign every pixel, caching by 5-bit-per-channel colour bucket.
  const cache = new Int32Array(32 * 32 * 32).fill(-1);
  const indices = new Int32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (image.data[i * 4 + 3] < alphaThreshold) {
      indices[i] = -1;
      continue;
    }
    const r = image.data[i * 4];
    const g = image.data[i * 4 + 1];
    const b = image.data[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let best = cache[key];
    if (best < 0) {
      let bestDist = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const c = palette[k];
        const d = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      }
      cache[key] = best;
    }
    indices[i] = best;
  }

  return { palette, indices };
}

/**
 * Averages each pixel with its neighbours. One or two passes before
 * quantization removes JPEG ringing that would otherwise become stray shapes.
 */
export function blur(image: ImageData8, passes = 1): ImageData8 {
  if (passes <= 0) return image;
  const { width, height } = image;
  let source: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(image.data);
  let target: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(source.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const sy = y + dy;
          if (sy < 0 || sy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx;
            if (sx < 0 || sx >= width) continue;
            const o = (sy * width + sx) * 4;
            r += source[o];
            g += source[o + 1];
            b += source[o + 2];
            a += source[o + 3];
            n += 1;
          }
        }
        const o = (y * width + x) * 4;
        target[o] = r / n;
        target[o + 1] = g / n;
        target[o + 2] = b / n;
        target[o + 3] = a / n;
      }
    }
    const swap = source;
    source = target;
    target = swap;
  }
  return { width, height, data: source };
}
