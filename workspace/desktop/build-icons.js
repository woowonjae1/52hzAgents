const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '../..');
const svgPath = path.join(__dirname, 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf-8');

// ── Render SVG to PNG at given size ─────────────────────────────────────────
function renderPNG(size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const rendered = resvg.render();
  return rendered.asPng();
}

// ── Build multi-res ICO with PNG frames ─────────────────────────────────────
function buildICO(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type = ICO
  header.writeUInt16LE(count, 4); // image count

  let offset = headerSize;
  for (let i = 0; i < count; i++) {
    const { size, png } = pngBuffers[i];
    const entryOff = 6 + i * 16;
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;

    header.writeUInt8(w, entryOff);
    header.writeUInt8(h, entryOff + 1);
    header.writeUInt8(0, entryOff + 2);   // color count
    header.writeUInt8(0, entryOff + 3);   // reserved
    header.writeUInt16LE(1, entryOff + 4);  // color planes
    header.writeUInt16LE(32, entryOff + 6); // bpp
    header.writeUInt32LE(png.length, entryOff + 8);
    header.writeUInt32LE(offset, entryOff + 12);
    offset += png.length;
  }

  return Buffer.concat([header, ...pngBuffers.map(p => p.png)]);
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
console.log('Building multi-resolution ICO...');

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map(size => {
  if (!pngCache[size]) {
    console.log(`  Rendering ${size}x${size}...`);
    pngCache[size] = renderPNG(size);
  }
  return { size, png: pngCache[size] };
});

const ico = buildICO(icoPngs);
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
