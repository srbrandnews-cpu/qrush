'use strict';

/**
 * Order notifications — browser push (web push).
 *
 * WhatsApp / SMS channels have been removed: they needed a paid provider
 * account (MSG91/Twilio), template approval and DLT registration, which made
 * the product much harder to sell and to set up.
 *
 * The code for those channels still lives in git history / the previous
 * version of this file, so they can be brought back later if a restaurant
 * explicitly pays for them.
 *
 * Every attempt is written to the `notifications` table, which doubles as a
 * delivery log the restaurant owner can see in the admin panel.
 */

const { run } = require('../config/db');
const push = require('./push');

const PROVIDER = 'web-push';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Turn any user-typed phone into E.164-ish (+919876543210).
 * Kept because the customer table can still show a phone number, and a
 * restaurant owner may want to call a guest whose order is stuck.
 */
function normalizePhone(raw, countryCode = '+91') {
  if (!raw) return null;
  let p = String(raw).replace(/[\s\-().]/g, '');
  if (!p) return null;

  const cc = String(countryCode || '+91').replace(/[^\d]/g, '') || '91';

  // 00 is the international dialling prefix: 00 <country code> <number>
  if (p.startsWith('00')) p = p.slice(2);

  if (!p.startsWith('+')) {
    if (p.startsWith('0')) p = cc + p.slice(1);        // 09876543210 -> 91 9876543210
    else if (p.length === 10) p = cc + p;               // 9876543210   -> 91 9876543210
    // else: already contains the country code (e.g. 919876543210) — leave it
  }

  p = '+' + p.replace(/^\+/, '');
  return /^\+\d{8,15}$/.test(p) ? p : null;
}

/** Channels enabled for a tenant (only 'push' is supported now). */
function channelsFor(tenant) {
  const raw = (tenant && tenant.notify_channels) || 'push';
  const list = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes('push') ? ['push'] : [];
}

/* -------------------------------------------------------------------------- */
/*  Delivery                                                                  */
/* -------------------------------------------------------------------------- */

/** Record a notification attempt in the database. */
async function logNotification({ tenantId, orderId, channel, provider, recipient, body, status, providerRef, error }) {
  try {
    await run(
      `INSERT INTO notifications (tenant_id, order_id, channel, provider, recipient, body, status, provider_ref, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, orderId || null, channel, provider, recipient || null, body || null,
       status, providerRef || null, error || null]
    );
  } catch (err) {
    console.error('[notify] could not write log:', err.message);
  }
}

/**
 * Send an order update to the customer's phone via web push.
 */
async function notifyOrderUpdate(tenant, order, payload) {
  if (!tenant || !order) return [];

  const results = [];
  const channels = channelsFor(tenant);

  if (!channels.includes('push')) {
    await logNotification({ tenantId: tenant.id, orderId: order.id, channel: 'push', provider: PROVIDER,
      body: payload.body, status: 'skipped', error: 'push channel disabled' });
    return results;
  }

  try {
    const sent = await push.sendToDevice(tenant.id, order.device_id, {
      title: payload.title,
      body: payload.body,
      url: `/menu?table=${order.table_token}&order=${order.id}`,
      tag: `order-${order.id}-${payload.event || ''}`,
    });
    await logNotification({ tenantId: tenant.id, orderId: order.id, channel: 'push', provider: PROVIDER,
      recipient: order.device_id, body: payload.body, status: sent > 0 ? 'sent' : 'skipped',
      error: sent > 0 ? null : 'customer has not allowed notifications on this phone' });
    results.push({ channel: 'push', status: sent > 0 ? 'sent' : 'skipped' });
  } catch (err) {
    await logNotification({ tenantId: tenant.id, orderId: order.id, channel: 'push', provider: PROVIDER,
      body: payload.body, status: 'failed', error: err.message });
    results.push({ channel: 'push', status: 'failed', error: err.message });
  }

  return results;
}

/** Is push actually usable right now? */
function providerStatus() {
  return { provider: PROVIDER, configured: true };
}

module.exports = { notifyOrderUpdate, normalizePhone, logNotification, providerStatus, PROVIDER };
