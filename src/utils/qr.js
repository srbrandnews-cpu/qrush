'use strict';

const QRCode = require('qrcode');

/**
 * Public base URL that a phone reaches this server on (set in .env, e.g.
 * https://order.myhotel.com or http://192.168.1.5:3000 for local LAN use).
 */
function baseUrl() {
  return (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

/**
 * The URL encoded inside a table's QR sticker. Scanning it opens the menu
 * straight on that table's page.
 */
function menuUrl(tableToken) {
  return `${baseUrl()}/menu?table=${tableToken}`;
}

/**
 * Return the menu URL as a PNG data-URL, ready to drop into an <img> or print.
 */
async function menuQrDataUrl(tableToken, opts = {}) {
  return QRCode.toDataURL(menuUrl(tableToken), {
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: opts.scale || 6,
    color: { dark: '#111827', light: '#ffffff' },
    ...opts,
  });
}

module.exports = { baseUrl, menuUrl, menuQrDataUrl };
