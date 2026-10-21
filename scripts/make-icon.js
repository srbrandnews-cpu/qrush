'use strict';

/**
 * Generates the TableNest icon set (a teal rounded square with a food cloche)
 * as real PNG files — no image tools or dependencies required.
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

  // Each scanline is prefixed with filter type 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* --------------------------------- draw --------------------------------- */

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 192; // design on a 192 grid, scale up
  const cx = 96, cy = 96;

  const TEAL = [13, 148, 136, 255];
  const DARK = [17, 94, 89, 255];
  const WHITE = [255, 255, 255, 255];

  const set = (x, y, col) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (Math.floor(y) * size + Math.floor(x)) * 4;
    rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = col[3];
  };

  const inRoundedRect = (x, y, r) => {
    const minX = r, maxX = size - r, minY = r, maxY = size - r;
    if (x < minX && y < minY) return (minX - x) ** 2 + (minY - y) ** 2 <= r * r;
    if (x > maxX && y < minY) return (x - maxX) ** 2 + (minY - y) ** 2 <= r * r;
    if (x < minX && y > maxY) return (minX - x) ** 2 + (y - maxY) ** 2 <= r * r;
    if (x > maxX && y > maxY) return (x - maxX) ** 2 + (y - maxY) ** 2 <= r * r;
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  };

  // Soft vertical gradient background inside a rounded square.
  const corner = 44 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundedRect(x, y, corner)) continue; // stays transparent
      const t = y / size;
      set(x, y, [
        Math.round(13 + (17 - 13) * t),
        Math.round(148 + (94 - 148) * t),
        Math.round(136 + (89 - 136) * t),
        255,
      ]);
    }
  }

  // --- Food cloche (dome + knob + base plate), all white ---
  const plateY = 126 * s, plateH = 15 * s, plateW = 116 * s;
  const domeR = 58 * s, domeBaseY = plateY - 4 * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx * s, dy = y - domeBaseY;

      // Dome: upper half of a circle.
      if (dy <= 0 && dx * dx + dy * dy <= domeR * domeR) set(x, y, WHITE);

      // Base plate: rounded horizontal bar.
      const px = x - (cx * s - plateW / 2);
      const py = y - plateY;
      if (px >= 0 && px <= plateW && py >= 0 && py <= plateH) {
        const rr = plateH / 2;
        const leftEdge = rr, rightEdge = plateW - rr;
        let inside = px >= leftEdge && px <= rightEdge;
        if (!inside) {
          const ex = px < leftEdge ? leftEdge : rightEdge;
          inside = (px - ex) ** 2 + (py - plateH / 2) ** 2 <= rr * rr;
        }
        if (inside) set(x, y, WHITE);
      }

      // Knob on top of the dome.
      const kx = x - cx * s, ky = y - (domeBaseY - domeR - 4 * s);
      if (kx * kx + ky * ky <= (9 * s) * (9 * s)) set(x, y, WHITE);
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
