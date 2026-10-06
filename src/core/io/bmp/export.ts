/**
 * BMP writing. The canvas API can encode PNG, JPEG and WebP but not BMP, so
 * this is the one raster format the editor has to serialize itself. It lives
 * here beside the SVG and PDF writers rather than in the UI layer.
 */

/**
 * Encodes RGBA pixels as an uncompressed 24-bit BMP.
 *
 * `pixels` is a row-major RGBA buffer as `getImageData` returns it. BMP has no
 * alpha channel at 24 bits, so translucent pixels are composited onto white.
 */
export function encodeBmp(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);

  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelDataSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  // BMP rows run bottom-up and store colours as BGR.
  for (let y = 0; y < height; y++) {
    const sourceRow = (height - 1 - y) * width * 4;
    let target = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * 4;
      const alpha = pixels[source + 3] / 255;
      // Composite onto white, since 24-bit BMP has no alpha channel.
      bytes[target++] = Math.round(pixels[source + 2] * alpha + 255 * (1 - alpha));
      bytes[target++] = Math.round(pixels[source + 1] * alpha + 255 * (1 - alpha));
      bytes[target++] = Math.round(pixels[source] * alpha + 255 * (1 - alpha));
    }
  }
  return bytes;
}
