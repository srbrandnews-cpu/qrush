'use strict';

/**
 * Generates the QRush icon set — a teal squircle with a white "Q" ring and a
 * lightning-bolt tail (Q + rush). Pure Node, no image libraries.
 *
 * Run:  node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------- PNG encode ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* --------------------------------- shape --------------------------------- */
// Everything is designed on a 192 x 192 grid, then scaled to any size.

const RING = { cx: 88, cy: 84, r: 44, w: 20 };
const BOLT = [
  [116, 100], [152, 100], [128, 130], [145, 130],
  [106, 170], [116, 138], [99, 138],
];

function inRoundedRect(x, y, size, r) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function gradientAt(t) {
  // teal 500 -> teal 700/800
  return [
    Math.round(20 + (13 - 20) * t),
    Math.round(184 + (116 - 184) * t),
    Math.round(166 + (105 - 166) * t),
  ];
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;                     // 4x4 supersampling for smooth edges
  const scale = 192 / size;         // pixel -> design grid
  const corner = 44;
  const white = [255, 255, 255];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, markHits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;

          if (!inRoundedRect(x, y, 192, corner)) continue;
          bgHits++;

          const dx = x - RING.cx, dy = y - RING.cy;
          const d = Math.hypot(dx, dy);
          const inRing = d >= RING.r - RING.w / 2 && d <= RING.r + RING.w / 2;
          if (inRing || inPolygon(x, y, BOLT)) markHits++;
        }
      }

      const total = SS * SS;
      if (!bgHits) continue; // transparent outside the squircle

      const i = (py * size + px) * 4;
      const alpha = Math.round((bgHits / total) * 255);
      const mark = markHits / Math.max(bgHits, 1);
      const bg = gradientAt(py / size);

      rgba[i] = Math.round(bg[0] * (1 - mark) + white[0] * mark);
      rgba[i + 1] = Math.round(bg[1] * (1 - mark) + white[1] * mark);
      rgba[i + 2] = Math.round(bg[2] * (1 - mark) + white[2] * mark);
      rgba[i + 3] = alpha;
    }
  }

  return encodePNG(size, rgba);
}

/* --------------------------------- write --------------------------------- */

const outDir = path.join(__dirname, '..', 'public', 'img');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log('wrote', path.relative(process.cwd(), file));
}

const touch = path.join(outDir, 'apple-touch-icon.png');
fs.writeFileSync(touch, drawIcon(180));
console.log('wrote', path.relative(process.cwd(), touch));

const favicon = path.join(outDir, 'favicon.png');
fs.writeFileSync(favicon, drawIcon(64));
console.log('wrote', path.relative(process.cwd(), favicon));
