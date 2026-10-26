'use strict';

/**
 * End-to-end smoke test of the whole ordering flow:
 *   owner login -> place customer order -> kitchen advances it to "ready"
 *   -> cashier marks served + paid -> customer sees the right status.
 *
 * Start the server first (`npm start`), then run:  node scripts/test-flow.js
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
  console.log('\n=== QRush flow test ===\n');

  // 1. Staff logins
  const owner = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@demo.com', password: 'pass1234' } });
  assert(owner.status === 200 && owner.data.token, 'owner login works');
  const ownerToken = owner.data.token;

  const kitchen = await call('/api/auth/login', { method: 'POST', body: { email: 'kitchen@demo.com', password: 'pass1234' } });
  const kitchenToken = kitchen.data.token;

  const cashier = await call('/api/auth/login', { method: 'POST', body: { email: 'cashier@demo.com', password: 'pass1234' } });
  const cashierToken = cashier.data.token;

  // 2. Get a table QR token (this is what the QR code encodes)
  const tables = await call('/api/tables', { token: ownerToken });
  assert(tables.status === 200 && tables.data.tables.length > 0, 'owner can list tables');
  const table = tables.data.tables[0];
  const tableToken = table.qr_token;

  // 3. Customer scans QR -> sees menu
  const menu = await call('/api/public/menu?table=' + encodeURIComponent(tableToken));
  assert(menu.status === 200 && menu.data.menu.length > 0, 'customer sees menu after scanning QR');
  const firstItem = menu.data.menu[0].items[0];
  const currency = menu.data.restaurant.currency;

  // 4. Customer places an order
  const order = await call('/api/public/orders', {
    method: 'POST',
    body: {
      table: tableToken,
      deviceId: 'test-device-1',
      customerName: 'Test Customer',
      items: [{ item_id: firstItem.id, qty: 2 }, { item_id: menu.data.menu[0].items[1].id, qty: 1 }],
    },
  });
  assert(order.status === 201 && order.data.order.id, 'customer can place an order');
  const placed = order.data.order;
  assert(placed.status === 'placed', 'new order starts as "placed"');
  assert(placed.total > 0, 'order total computed (' + currency + placed.total + ')');

  // 5. Kitchen sees it in the open queue
  const open = await call('/api/orders?board=open', { token: kitchenToken });
  assert(open.data.orders.some((o) => o.id === placed.id), 'kitchen sees the order in the open queue');

  // 6. Kitchen advances: placed -> accepted -> preparing -> ready
  let adv = await call(`/api/orders/${placed.id}/transition`, { method: 'POST', token: kitchenToken, body: { to: 'accepted' } });
  assert(adv.status === 200 && adv.data.order.status === 'accepted', 'kitchen accepts the order');

  adv = await call(`/api/orders/${placed.id}/transition`, { method: 'POST', token: kitchenToken, body: { to: 'preparing' } });
  assert(adv.data.order.status === 'preparing', 'kitchen starts preparing');

  adv = await call(`/api/orders/${placed.id}/transition`, { method: 'POST', token: kitchenToken, body: { to: 'ready' } });
  assert(adv.data.order.status === 'ready', 'kitchen marks ready -> customer gets push notification');

  // 7. Cashier: ready -> served -> paid
  adv = await call(`/api/orders/${placed.id}/transition`, { method: 'POST', token: cashierToken, body: { to: 'served' } });
  assert(adv.status === 200 && adv.data.order.status === 'served', 'cashier marks served');

  adv = await call(`/api/orders/${placed.id}/transition`, { method: 'POST', token: cashierToken, body: { to: 'paid', payment_method: 'cash' } });
  assert(adv.data.order.status === 'paid' && adv.data.order.payment_status === 'paid', 'cashier collects payment');
  assert(adv.data.order.payment_method === 'cash', 'payment method recorded as cash');

  // 8. Customer tracks the final status (scoped to their own device)
  const finalStatus = await call(`/api/public/orders/${placed.id}?table=` + encodeURIComponent(tableToken) +
    '&deviceId=test-device-1');
  assert(finalStatus.data.order.status === 'paid', 'customer sees "paid" status');

  // Another guest with the same table QR must not read this bill.
  const peeking = await call(`/api/public/orders/${placed.id}?table=` + encodeURIComponent(tableToken) +
    '&deviceId=someone-else');
  assert(peeking.status === 404, 'another device on the same table cannot read the bill');

  // 9. Role guard: a kitchen user cannot move a READY order to "served" (cashier's job)
  const order2 = await call('/api/public/orders', {
    method: 'POST',
    body: { table: tableToken, deviceId: 'test-device-1', items: [{ item_id: firstItem.id, qty: 1 }] },
  });
  const oid2 = order2.data.order.id;
  await call(`/api/orders/${oid2}/transition`, { method: 'POST', token: kitchenToken, body: { to: 'accepted' } });
  await call(`/api/orders/${oid2}/transition`, { method: 'POST', token: kitchenToken, body: { to: 'preparing' } });
  await call(`/api/orders/${oid2}/transition`, { method: 'POST', token: kitchenToken, body: { to: 'ready' } });
  const bad = await call(`/api/orders/${oid2}/transition`, { method: 'POST', token: kitchenToken, body: { to: 'served' } });
  assert(bad.status === 403, 'role guard blocks kitchen from cashier actions');

  // 10. Invalid jump is rejected too (ready cannot skip straight back to preparing)
  const badJump = await call(`/api/orders/${oid2}/transition`, { method: 'POST', token: cashierToken, body: { to: 'preparing' } });
  assert(badJump.status === 409, 'invalid status jump is rejected');

  // 11. Customer cannot read another table's order by guessing the id
  const other = await call(`/api/public/orders/${oid2}?table=` + encodeURIComponent(tables.data.tables[1].qr_token));
  assert(other.status === 404, 'customer cannot read another table\'s order');

  console.log('\n✅ All flow tests passed!\n');
}

main().catch((err) => {
  console.error('\n' + err.message + '\n');
  process.exit(1);
});
