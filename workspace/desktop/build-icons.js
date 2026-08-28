const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '../..');
const svgPath = path.join(__dirname, 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf-8');

function renderRaw(size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const rendered = resvg.render();
  return { pixels: rendered.pixels, png: rendered.asPng() };
}

function renderPNG(size) {
  return renderRaw(size).png;
}

// ── Convert RGBA buffer to Windows DIB buffer (for sizes < 256) ─────────────
function rgbaToDIB(size, rgba) {
  const dibHeaderSize = 40;
  const pixelDataSize = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskSize = maskRowBytes * size;
  const totalSize = dibHeaderSize + pixelDataSize + maskSize;

  const buf = Buffer.alloc(totalSize);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 0);              // biSize
  buf.writeInt32LE(size, 4);             // biWidth
  buf.writeInt32LE(size * 2, 8);         // biHeight (doubled for ICO mask!)
  buf.writeUInt16LE(1, 12);              // biPlanes
  buf.writeUInt16LE(32, 14);             // biBitCount (32-bit BGRA)
  buf.writeUInt32LE(0, 16);              // biCompression (BI_RGB = uncompressed)
  buf.writeUInt32LE(pixelDataSize + maskSize, 20); // biSizeImage
  buf.writeInt32LE(0, 24);              // biXPelsPerMeter
  buf.writeInt32LE(0, 28);              // biYPelsPerMeter
  buf.writeUInt32LE(0, 32);             // biClrUsed
  buf.writeUInt32LE(0, 36);             // biClrImportant

  // Write pixel data: bottom-to-top rows, BGRA order
  let dstOffset = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const srcIdx = (y * size + x) * 4;
      const r = rgba[srcIdx];
      const g = rgba[srcIdx + 1];
      const b = rgba[srcIdx + 2];
      const a = rgba[srcIdx + 3];

      buf.writeUInt8(b, dstOffset);
      buf.writeUInt8(g, dstOffset + 1);
      buf.writeUInt8(r, dstOffset + 2);
      buf.writeUInt8(a, dstOffset + 3);
      dstOffset += 4;
    }
  }

  // 1-bit AND mask is already 0 (transparent handled by 32-bit alpha)
  return buf;
}

// ── Build multi-res ICO (DIB for sizes < 256, PNG for 256) ──────────────────
function buildICO(frames) {
  const count = frames.length;
  const headerSize = 6 + count * 16;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type = ICO
  header.writeUInt16LE(count, 4); // image count

  let offset = headerSize;
  for (let i = 0; i < count; i++) {
    const { size, buffer } = frames[i];
    const entryOff = 6 + i * 16;
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;

    header.writeUInt8(w, entryOff);
    header.writeUInt8(h, entryOff + 1);
    header.writeUInt8(0, entryOff + 2);   // color count
    header.writeUInt8(0, entryOff + 3);   // reserved
    header.writeUInt16LE(1, entryOff + 4);  // color planes
    header.writeUInt16LE(32, entryOff + 6); // bpp
    header.writeUInt32LE(buffer.length, entryOff + 8);
    header.writeUInt32LE(offset, entryOff + 12);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...frames.map(f => f.buffer)]);
}

// ── Generate PNGs ───────────────────────────────────────────────────────────
console.log('Rendering SignalMark from SVG via resvg...');

const pngOutputs = [
  { size: 512, out: 'workspace/desktop/icon.png' },
  { size: 512, out: 'workspace/frontend/public/logo-icon.png' },
  { size: 512, out: 'workspace/frontend/public/android-chrome-512x512.png' },
  { size: 512, out: 'workspace/frontend/public/logo-black.png' },
  { size: 512, out: 'workspace/frontend/public/logo-white.png' },
  { size: 192, out: 'workspace/frontend/public/android-chrome-192x192.png' },
  { size: 180, out: 'workspace/frontend/public/apple-touch-icon.png' },
  { size: 64,  out: 'workspace/desktop/tray-icon.png' },
  { size: 32,  out: 'workspace/frontend/public/favicon-32x32.png' },
  { size: 16,  out: 'workspace/frontend/public/favicon-16x16.png' },
];

const pngCache = {};
for (const { size, out } of pngOutputs) {
  if (!pngCache[size]) {
    console.log(`  Rendering ${size}x${size}...`);
    pngCache[size] = renderPNG(size);
  }
  const outPath = path.join(root, out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pngCache[size]);
  console.log(`  -> ${out} (${pngCache[size].length} bytes)`);
}

// ── Generate ICO ────────────────────────────────────────────────────────────
console.log('Building multi-resolution ICO (hybrid DIB + PNG)...');

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoFrames = icoSizes.map(size => {
  console.log(`  Rendering ICO frame ${size}x${size}...`);
  const raw = renderRaw(size);
  if (size >= 256) {
    return { size, buffer: raw.png };
  } else {
    return { size, buffer: rgbaToDIB(size, raw.pixels) };
  }
});

const ico = buildICO(icoFrames);
console.log(`  ICO total: ${ico.length} bytes, ${icoSizes.length} frames`);

const icoTargets = [
  'workspace/desktop/icon.ico',
  'workspace/desktop/build/icon.ico',
  'workspace/desktop/resources/public/favicon.ico',
  'workspace/frontend/public/favicon.ico',
  'packages/go/web/public/favicon.ico'
];

for (const rel of icoTargets) {
  const outPath = path.join(root, rel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, ico);
  console.log(`  -> ${rel}`);
}

console.log('\nAll SignalMark icons generated successfully!');
