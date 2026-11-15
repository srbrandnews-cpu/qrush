/**
 * Helpers for uploaded free-QR menu images.
 *
 * iPhones shoot HEIC/HEIF by default. Most browsers cannot render HEIC at all
 * (Android Chrome shows a broken image, desktop Chrome too), so a menu photo
 * straight from an iPhone used to be stored and served as-is and simply never
 * appeared. Convert HEIC to JPEG on the server so the menu always displays,
 * regardless of the phone or browser the customer uses.
 */

let heicConvert = null;

function getHeicConvert() {
  if (!heicConvert) {
    // Lazy require so a missing dependency can never stop the server booting.
    heicConvert = require('heic-convert');
  }
  return heicConvert;
}

const HEIC_TYPE = /^image\/hei[cf]/i;
const DATA_URL = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

function isHeicDataUrl(value) {
  return HEIC_TYPE.test(String(value || '').trim().slice(0, 40));
}

/** Parse menu_data into an array of data-URI / URL strings. */
function parseMenuImages(data) {
  const s = typeof data === 'string' ? data.trim() : '';
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
      }
    } catch (_) { /* fall through */ }
  }
  return [s];
}

function joinMenuImages(images) {
  return images.length === 1 ? images[0] : JSON.stringify(images);
}

async function convertHeicBuffer(buf, quality) {
  const out = await getHeicConvert()({
    buffer: buf,
    format: 'JPEG',
    quality: quality || 0.8,
  });
  return Buffer.from(out);
}

async function heicDataUrlToJpeg(dataUrl) {
  const match = DATA_URL.exec(String(dataUrl || ''));
  if (!match) throw new Error('Invalid data URL');
  const buf = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'binary');
  const jpeg = await convertHeicBuffer(buf);
  return 'data:image/jpeg;base64,' + jpeg.toString('base64');
}

/**
 * Convert a single value if it is a HEIC data URL.
 * Returns { value, changed, error? }; never throws.
 */
async function convertHeicValue(value) {
  if (!isHeicDataUrl(value)) return { value, changed: false };
  try {
    return { value: await heicDataUrlToJpeg(value), changed: true };
  } catch (err) {
    console.warn('[menu-image] HEIC conversion failed:', err.message);
    return { value, changed: false, error: err };
  }
}

/**
 * Normalise menu_data (single data URL or JSON array) so every HEIC page
 * becomes a browser-friendly JPEG.
 */
async function normalizeMenuData(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { value: s, changed: false };

  const images = parseMenuImages(s);
  let changed = false;
  const out = [];
  for (const img of images) {
    const res = await convertHeicValue(img);
    if (res.changed) changed = true;
    out.push(res.value);
  }
  if (!changed) return { value: s, changed: false };
  return { value: joinMenuImages(out), changed: true };
}

/** Normalise a logo value (null stays null). */
async function normalizeLogo(raw) {
  if (!raw) return { value: raw, changed: false };
  return convertHeicValue(raw);
}

module.exports = {
  isHeicDataUrl,
  parseMenuImages,
  convertHeicBuffer,
  convertHeicValue,
  normalizeMenuData,
  normalizeLogo,
};
