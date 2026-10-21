'use strict';

/**
 * Tests the notification pipeline (browser push).
 *
 * WhatsApp/SMS channels have been removed, so this checks that:
 *   - push notifications are recorded in the delivery log
 *   - a customer who has not allowed notifications is handled gracefully
 *   - the push channel cannot be switched off from the admin panel
 *
 * Run:  node scripts/test-notifications.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  console.log('\n=== Notification pipeline test (browser push) ===\n');

  // --- 1. Phone normalisation (still used to show a contact number) ---
  const { normalizePhone } = require('../src/services/notify');
  assert(normalizePhone('9876543210', '+91') === '+919876543210', '10-digit number -> +919876543210');
  assert(normalizePhone('09876543210', '+91') === '+919876543210', 'leading 0 handled');
  assert(normalizePhone('+91 98765 43210', '+91') === '+919876543210', 'spaces handled');
  assert(normalizePhone('009876543210', '+91') === '+919876543210', '00 prefix handled');
  assert(normalizePhone('', '+91') === null, 'empty phone -> null');
  assert(normalizePhone('abc', '+91') === null, 'garbage phone -> null');

  // --- 2. Log in ---
  const login = await api('/api/auth/login', {
    method: 'POST', body: { email: 'owner@demo.com', password: 'pass1234' },
  });
  assert(login.status === 200 && login.data.token, 'owner logged in');
  const token = login.data.token;

  // --- 3. Push is the only allowed channel ---
  const saved = await api('/api/admin/notifications-settings', {
    method: 'PUT', token, body: { country_code: '+91', notify_channels: ['push', 'whatsapp', 'sms'] },
  });
  assert(saved.status === 200, 'notification settings saved');
  assert(saved.data.restaurant.notify_channels === 'push',
    'whatsapp/sms channels are gone — only push remains: ' + saved.data.restaurant.notify_channels);

  // --- 4. Place an order and move it to ready ---
  const tables = await api('/api/tables', { token });
  const tableToken = tables.data.tables[0].qr_token;
  const menu = await api('/api/public/menu?table=' + encodeURIComponent(tableToken));
  const item = menu.data.menu[0].items[0];

  const kitchen = await api('/api/auth/login', {
    method: 'POST', body: { email: 'kitchen@demo.com', password: 'pass1234' },
  });
  const kToken = kitchen.data.token;

  const order = await api('/api/public/orders', {
    method: 'POST',
    body: {
      table: tableToken,
      deviceId: 'notif-test-device',
      customerName: 'Notify Tester',
      items: [{ item_id: item.id, qty: 1 }],
    },
  });
  assert(order.status === 201, 'order placed (no phone number needed any more)');
  const orderId = order.data.order.id;

  for (const to of ['accepted', 'preparing', 'ready']) {
    const r = await api(`/api/orders/${orderId}/transition`, { method: 'POST', token: kToken, body: { to } });
    assert(r.status === 200, 'transition -> ' + to);
  }

  // --- 5. Delivery log ---
  const after = await api('/api/admin/notifications?limit=200', { token });
  const mine = after.data.notifications.filter((n) => n.order_id === orderId);
  const push = mine.find((n) => n.channel === 'push');
  assert(!!push, 'push notification recorded in the delivery log');
  assert(push.body && push.body.includes('Order #'), 'body contains the order number');
  assert(push.body.includes('ready'), 'body says the order is ready');
  assert(!mine.some((n) => n.channel === 'whatsapp' || n.channel === 'sms'),
    'no whatsapp/sms entries at all');

  // --- 6. A customer who never allowed notifications is handled gracefully ---
  assert(push.status === 'skipped' || push.status === 'sent',
    'status is sent or skipped (never an error): ' + push.status);
  if (push.status === 'skipped') {
    assert(/not allowed|subscription/i.test(push.error || ''), 'skip reason is clear: ' + push.error);
  }

  console.log('\n✅ Notification pipeline works correctly (browser push only).\n');
}

main().catch((err) => {
  console.error('\n' + err.message + '\n');
  process.exit(1);
});
