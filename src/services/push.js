'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { query, run } = require('../config/db');

let ready = false;

/**
 * VAPID keys identify our server to the push service. They must stay stable
 * across restarts (otherwise saved subscriptions break), so if they are not
 * provided via env we generate once and persist to a file.
 */
function ensureVapidKeys() {
  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    const keyFile = process.env.VAPID_KEY_FILE ||
      path.join(__dirname, '..', '..', 'data', 'vapid.json');
    if (fs.existsSync(keyFile)) {
      const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      publicKey = saved.publicKey;
      privateKey = saved.privateKey;
    } else {
      const generated = webpush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, JSON.stringify(generated), 'utf8');
    }
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@tablenest.app',
    publicKey,
    privateKey
  );
  return { publicKey, privateKey };
}

let vapidKeys = null;

function init() {
  if (ready) return;
  vapidKeys = ensureVapidKeys();
  ready = true;
}

function publicKey() {
  if (!ready) init();
  return vapidKeys.publicKey;
}

/**
 * Save (or update) a device's push subscription.
 */
async function saveSubscription(tenantId, deviceId, subscription) {
  const endpoint = subscription && subscription.endpoint;
  if (!endpoint) return;
  const json = JSON.stringify(subscription);
  await run(
    `INSERT INTO push_subscriptions (tenant_id, device_id, endpoint, subscription)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       device_id = excluded.device_id,
       tenant_id = excluded.tenant_id,
       subscription = excluded.subscription`,
    [tenantId, deviceId, endpoint, json]
  );
}

async function removeSubscription(endpoint) {
  await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

/**
 * Send a push to one subscription. Returns 'ok' | 'gone' | 'error'.
 * A 404/410 means the subscription is dead — we delete it.
 */
async function sendToOne(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return 'ok';
  } catch (err) {
    const status = err && err.statusCode;
    if (status === 404 || status === 410) {
      return 'gone';
    }
    // Encrypted payload is too large or keys invalid — nothing to retry.
    if (status === 413) return 'error';
    console.error('[push] send failed:', err.message);
    return 'error';
  }
}

/**
 * Notify every device registered for a tenant+device_id.
 */
async function sendToDevice(tenantId, deviceId, payload) {
  if (!deviceId) return 0;
  const rows = await query(
    'SELECT id, subscription FROM push_subscriptions WHERE tenant_id = ? AND device_id = ?',
    [tenantId, deviceId]
  );
  let sent = 0;
  for (const row of rows) {
    let sub;
    try { sub = JSON.parse(row.subscription); } catch (_) { continue; }
    const result = await sendToOne(sub, payload);
    if (result === 'gone') await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
    if (result === 'ok') sent++;
  }
  return sent;
}

module.exports = {
  init,
  publicKey,
  saveSubscription,
  removeSubscription,
  sendToDevice,
  sendToOne,
};
