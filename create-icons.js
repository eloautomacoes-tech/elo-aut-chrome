/**
 * Creates PNG icons without external dependencies.
 * Uses raw PNG format with Node.js built-in zlib.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR);

function createPNG(size) {
  const width = size;
  const height = size;

  // Build RGBA pixel buffer
  const pixels = Buffer.alloc(width * height * 4);

  const cx = width / 2;
  const cy = height / 2;
  const r = width / 2;

  // Brand gradient stops (Elo design system): 118deg, cyan -> blue -> violet
  const stops = [
    { t: 0.00, c: [41, 169, 255] },  // #29a9ff
    { t: 0.42, c: [46, 107, 255] },  // #2e6bff
    { t: 1.00, c: [122, 60, 240] },  // #7a3cf0
  ];
  const angleRad = (118 - 90) * Math.PI / 180; // CSS gradient angle -> direction vector

  function gradientColorAt(nx, ny) {
    // Project point onto gradient axis, normalized 0..1 across the icon
    const proj = (nx * Math.cos(angleRad) + ny * Math.sin(angleRad) + 0.5);
    const t = Math.min(1, Math.max(0, proj));
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].t && t <= stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const span = b.t - a.t || 1;
    const lt = (t - a.t) / span;
    return [
      Math.round(a.c[0] + (b.c[0] - a.c[0]) * lt),
      Math.round(a.c[1] + (b.c[1] - a.c[1]) * lt),
      Math.round(a.c[2] + (b.c[2] - a.c[2]) * lt),
    ];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Rounded square mask
      const rx = Math.abs(dx) / (width * 0.42);
      const ry = Math.abs(dy) / (height * 0.42);
      const insideRoundedSquare = Math.pow(rx, 6) + Math.pow(ry, 6) <= 1;

      if (!insideRoundedSquare) {
        // Transparent outside
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
        continue;
      }

      // Brand gradient background (Elo design system)
      const [gr, gg, gb] = gradientColorAt(dx / width, dy / height);
      let R = gr;
      let G = gg;
      let B = gb;

      // Draw simplified white cloud shape
      const nx = (x - cx) / width;  // normalized -0.5 to 0.5
      const ny = (y - cy) / height;

      // Cloud made of 3 circles + base rect
      const cloud = (
        circleHit(nx, ny, -0.12, -0.05, 0.15) ||
        circleHit(nx, ny, 0.02, -0.14, 0.12) ||
        circleHit(nx, ny, 0.18, -0.07, 0.10) ||
        // base rectangle
        (nx >= -0.22 && nx <= 0.28 && ny >= -0.04 && ny <= 0.14)
      );

      if (cloud) {
        R = 255;
        G = 255;
        B = 255;
      }

      pixels[idx] = R;
      pixels[idx + 1] = G;
      pixels[idx + 2] = B;
      pixels[idx + 3] = 255;
    }
  }

  // Build PNG raw scanlines (filter byte 0 = None per row)
  const rawLines = [];
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(1 + width * 4);
    line[0] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = 1 + x * 4;
      line[dstIdx] = pixels[srcIdx];
      line[dstIdx + 1] = pixels[srcIdx + 1];
      line[dstIdx + 2] = pixels[srcIdx + 2];
      line[dstIdx + 3] = pixels[srcIdx + 3];
    }
    rawLines.push(line);
  }

  const rawData = Buffer.concat(rawLines);
  const compressed = zlib.deflateSync(rawData, { level: 6 });

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type: RGBA
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT chunk
  const idat = makeChunk('IDAT', compressed);

  // IEND chunk
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function circleHit(nx, ny, cx, cy, r) {
  const dx = nx - cx;
  const dy = ny - cy;
  return dx * dx + dy * dy <= r * r;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);

  const typeBytes = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeInt32BE(crc32(crcBuf), 0);

  return Buffer.concat([len, typeBytes, data, crc]);
}

// CRC32 implementation
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) | 0;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

// Generate icons
[16, 48, 128].forEach(size => {
  const png = createPNG(size);
  const outPath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created: ${outPath} (${png.length} bytes)`);
});
