'use strict';

const QRCode = require('qrcode');
const { currentOrigin } = require('./request-context');

/**
 * Public base URL that a phone reaches this server on.
 *
 * Priority:
 *   1. BASE_URL from the environment (explicit intent: a fixed custom domain)
 *   2. the origin of the request being served (no configuration needed — this
 *      is what makes QR codes correct on any hostname automatically)
 *   3. localhost, for calls outside a request (scripts, tests)
 *
 * Because of (2), a deployment no longer breaks its QR codes when the URL
 * changes; BASE_URL is only needed if you want to force one specific domain.
 */
function baseUrl() {
  const configured = (process.env.BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const origin = currentOrigin();
  if (origin) return origin.replace(/\/+$/, '');

  return `http://localhost:${process.env.PORT || 3000}`;
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

/**
 * QR for any URL (staff screens, sharing links, etc).
 */
async function qrDataUrl(url, opts = {}) {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: opts.scale || 6,
    color: { dark: '#111827', light: '#ffffff' },
    ...opts,
  });
}

module.exports = { baseUrl, menuUrl, menuQrDataUrl, qrDataUrl };
