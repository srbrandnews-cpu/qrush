'use strict';

/**
 * Regression test for bill identity:
 *  - same table + same phone (even +91 / 0 formats) = one bill / add-on
 *  - same table + different phone = separate bill (Table 1A)
 *  - each guest only sees their own open orders on the customer screen
 *
 * Start the server, then:  BASE_URL=http://localhost:3100 node scripts/test-bill-merge.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function call(path, { method = 'GET', token, body } = {}) {
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
  console.log('\n=== QRush bill merge test ===\n');

  const owner = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@demo.com', password: 'pass1234' },
  });
  assert(owner.status === 200 && owner.data.token, 'owner login works');
  const token = owner.data.token;

  const tables = await call('/api/tables', { token });
  const table = tables.data.tables[0];
  assert(table && table.qr_token, 'table token available');

  const menu = await call('/api/public/menu?table=' + encodeURIComponent(table.qr_token));
  const item = menu.data.menu[0].items[0];
  const suffix = String(Date.now()).slice(-9);
  const phone = '9' + suffix;                       // 10 digit canonical
  const otherPhone = phone.slice(0, 9) + (phone.endsWith('9') ? '8' : '9');
  const devA = 'merge-dev-a-' + suffix;
  const devB = 'merge-dev-b-' + suffix;

  async function place(customerPhone, deviceId) {
    const res = await call('/api/public/orders', {
      method: 'POST',
      body: {
        table: table.qr_token,
        deviceId,
        customerPhone,
        customerName: 'Merge Test',
        items: [{ item_id: item.id, qty: 1 }],
      },
    });
    assert(res.status === 201, 'order placed for ' + customerPhone);
    return res.data.order;
  }

  // Same bill, two different phone spellings.
  const first = await place('+91 ' + phone, devA);
  const addon = await place('0' + phone, devA);
  // Different guest on the same table.
  const second = await place(otherPhone, devB);

  const grouped = await call('/api/orders/grouped-by-table-phone?board=open&limit=500', { token });
  assert(grouped.status === 200, 'staff can read grouped bills');
  const groupOf = (id) => grouped.data.groups.find((g) => g.orders.some((o) => o.id === id));
  const g1 = groupOf(first.id);
  const g2 = groupOf(addon.id);
  const g3 = groupOf(second.id);
  assert(g1 && g2, 'both same-phone orders are in a bill');
  assert(g1.bill_key === g2.bill_key, 'same phone (different format) stays one bill');
  assert(g1.orders.some((o) => o.id === first.id) && g1.orders.some((o) => o.id === addon.id),
    'add-on order is grouped inside the same bill');
  assert(g3 && g3.bill_key !== g1.bill_key, 'a different phone on the same table gets a separate bill');
  assert(g3.display_name !== g1.display_name, 'separate bill gets a distinct label (' + g3.display_name + ')');

  // Customer views are scoped to their own phone/device.
  const mine = await call('/api/public/menu?table=' + encodeURIComponent(table.qr_token) +
    '&phone=' + encodeURIComponent(phone) + '&deviceId=' + encodeURIComponent(devA));
  const mineIds = (mine.data.activeOrders || []).map((o) => o.id);
  assert(mineIds.includes(first.id) && mineIds.includes(addon.id), 'returning phone sees both of its orders');
  assert(!mineIds.includes(second.id), 'menu does not expose another guest\'s order');

  const theirs = await call('/api/public/tables/' + encodeURIComponent(table.qr_token) +
    '/orders?deviceId=' + encodeURIComponent(devB));
  const theirIds = (theirs.data.orders || []).map((o) => o.id);
  assert(theirIds.includes(second.id), 'second device sees its own order');
  assert(!theirIds.includes(first.id) && !theirIds.includes(addon.id), 'second device cannot see the first bill');

  // Clean up so this test leaves no open bills behind.
  for (const order of [first, addon, second]) {
    const res = await call(`/api/orders/${order.id}/transition`, {
      method: 'POST',
      token,
      body: { to: 'cancelled' },
    });
    assert(res.status === 200, 'test order #' + order.id + ' cancelled');
  }

  console.log('\n✅ Bill merge tests passed!\n');
}

main().catch((err) => {
  console.error('\n' + err.message + '\n');
  process.exit(1);
});
