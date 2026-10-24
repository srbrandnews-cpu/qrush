'use strict';

const { query, get, run, transaction, utcNow } = require('../config/db');
const { ORDER_STATUS, TRANSITIONS, TRANSITION_ROLE, CUSTOMER_FLOW, STATUS_LABEL } = require('../utils/constants');
const { emitOrderUpdate } = require('../realtime/socket');
const notify = require('./notify');

/**
 * Build the full order object (with items + table token) used by both the
 * kitchen/cashier boards and the customer status screen.
 */
async function getOrderWithItems(orderId) {
  const order = await get(
    `SELECT o.*, t.name AS table_name, t.qr_token AS table_token
       FROM orders o
       JOIN tables t ON t.id = o.table_id
      WHERE o.id = ?`,
    [orderId]
  );
  if (!order) return null;

  const items = await query(
    'SELECT id, item_id, name, price, qty, is_veg, notes FROM order_items WHERE order_id = ? ORDER BY id',
    [orderId]
  );
  order.items = items.map((it) => ({ ...it, line_total: round2(it.price * it.qty) }));
  return order;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Next order number for a restaurant (1, 2, 3 ...). */
async function nextOrderNo(tenantId) {
  const row = await get('SELECT MAX(order_no) AS max_no FROM orders WHERE tenant_id = ?', [tenantId]);
  return (row && row.max_no ? row.max_no : 0) + 1;
}

/**
 * Place a new order from a customer's phone.
 *
 * payload: {
 *   tenantId, tableId,
 *   items: [{ item_id, qty, notes }],
 *   customerName, customerPhone, deviceId, notes
 * }
 */
async function createOrder(payload) {
  const { tenantId, tableId, items, customerName, customerPhone, deviceId, notes } = payload;

  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Cart is empty');
  }

  // Fetch + validate each menu item in one pass.
  const ids = items.map((i) => Number(i.item_id));
  const placeholders = ids.map(() => '?').join(',');
  const menuRows = await query(
    `SELECT id, name, price, is_veg, is_available FROM menu_items WHERE tenant_id = ? AND id IN (${placeholders})`,
    [tenantId, ...ids]
  );
  const menuById = new Map(menuRows.map((r) => [r.id, r]));

  const lines = [];
  for (const raw of items) {
    const qty = Math.max(1, Math.min(99, parseInt(raw.qty, 10) || 1));
    const item = menuById.get(Number(raw.item_id));
    if (!item) throw httpError(400, 'Menu item not found');
    if (!item.is_available) throw httpError(400, `"${item.name}" is currently unavailable`);
    lines.push({
      item_id: item.id,
      name: item.name,
      price: round2(item.price),
      qty,
      is_veg: item.is_veg,
      notes: (raw.notes || '').toString().slice(0, 200) || null,
    });
  }

  const tenant = await get('SELECT gst_percent FROM tenants WHERE id = ?', [tenantId]);
  const gstPercent = tenant ? Number(tenant.gst_percent) || 0 : 0;

  const subtotal = round2(lines.reduce((sum, l) => sum + l.price * l.qty, 0));
  const gstAmount = round2((subtotal * gstPercent) / 100);
  const total = round2(subtotal + gstAmount);
  const itemCount = lines.reduce((sum, l) => sum + l.qty, 0);

  const orderId = await transaction(async () => {
    const orderNo = await nextOrderNo(tenantId);
    const res = await run(
      `INSERT INTO orders
         (tenant_id, table_id, order_no, customer_name, customer_phone, device_id,
          status, item_count, subtotal, gst_amount, total, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId, tableId, orderNo,
        customerName || null, customerPhone || null, deviceId || null,
        ORDER_STATUS.PLACED, itemCount, subtotal, gstAmount, total,
        notes ? notes.toString().slice(0, 300) : null,
      ]
    );
    const id = res.lastInsertRowid;

    const stmt = `INSERT INTO order_items (order_id, item_id, name, price, qty, is_veg, notes)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`;
    for (const l of lines) {
      await run(stmt, [id, l.item_id, l.name, l.price, l.qty, l.is_veg, l.notes]);
    }
    await run(
      'INSERT INTO order_events (order_id, from_status, to_status, actor) VALUES (?, ?, ?, ?)',
      [id, null, ORDER_STATUS.PLACED, 'customer']
    );
    return id;
  });

  const order = await getOrderWithItems(orderId);
  emitOrderUpdate(order);
  return order;
}

/**
 * Move an order to a new status. Validates the transition and the actor's role,
 * then emits realtime updates (and a push notification when it becomes ready).
 */
async function transitionOrder({ orderId, toStatus, actor, paymentMethod = null }) {
  const order = await get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw httpError(404, 'Order not found');

  const from = order.status;
  if (from === toStatus) {
    // Idempotent: ignore repeats (e.g. double tap).
    return getOrderWithItems(orderId);
  }
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(toStatus)) {
    throw httpError(409, `Cannot move from "${STATUS_LABEL[from]}" to "${STATUS_LABEL[toStatus]}"`);
  }

  // Role gate: owner can do anything; otherwise the transition's role is required.
  const requiredRole = TRANSITION_ROLE[`${from}>${toStatus}`];
  if (actor.role !== 'owner' && requiredRole && actor.role !== requiredRole) {
    throw httpError(403, `Only ${requiredRole} can mark an order as ${STATUS_LABEL[toStatus]}`);
  }

  const paymentStatus = toStatus === ORDER_STATUS.PAID ? 'paid' : order.payment_status;
  const paidMethod = (toStatus === ORDER_STATUS.PAID && paymentMethod) ? paymentMethod : order.payment_method;

  await run(
    `UPDATE orders SET status = ?, payment_status = ?, payment_method = ?, updated_at = ? WHERE id = ?`,
    [toStatus, paymentStatus, paidMethod, utcNow(), orderId]
  );
  await run(
    'INSERT INTO order_events (order_id, from_status, to_status, actor) VALUES (?, ?, ?, ?)',
    [orderId, from, toStatus, actor.email || actor.name || 'system']
  );

  const updated = await getOrderWithItems(orderId);
  emitOrderUpdate(updated);

  // Core requirement: notify the customer's phone the moment the order is ready.
  if (toStatus === ORDER_STATUS.READY) {
    await notifyCustomer(updated, {
      event: 'ready',
      title: '🍽️ Aapka order ready hai!',
      body: `Order #${updated.order_no} ready hai! 🍽️ ${updated.table_name} par serve ke liye taiyar.`,
    });
  } else if (toStatus === ORDER_STATUS.SERVED) {
    await notifyCustomer(updated, {
      event: 'served',
      title: '✅ Order serve ho gaya',
      body: `Order #${updated.order_no} serve ho gaya ✅ ${updated.table_name} par enjoy karein!`,
    });
  } else if (toStatus === ORDER_STATUS.CANCELLED) {
    await notifyCustomer(updated, {
      event: 'cancelled',
      title: '❌ Order cancel ho gaya',
      body: `Order #${updated.order_no} cancel kar diya gaya hai ❌`,
    });
  }

  return updated;
}

/**
 * Notify the customer through every enabled channel (WhatsApp / SMS / push).
 * The tenant row decides which channels are on, and whether the customer
 * opted in to WhatsApp/SMS.
 */
async function notifyCustomer(order, payload) {
  try {
    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [order.tenant_id]);
    await notify.notifyOrderUpdate(tenant, order, payload);
  } catch (err) {
    console.error('[orders] notification failed:', err.message);
  }
}

/** Live status for the customer (no login needed). */
async function getCustomerOrder(tableToken, orderId) {
  const order = await getOrderWithItems(orderId);
  if (!order) return null;
  if (order.table_token !== tableToken) return null; // prevent ID guessing across tables
  return decorateForCustomer(order);
}

/**
 * Get orders grouped by table + customer_phone (for "separate bills per phone").
 * Returns array of { table_id, table_name, phone, display_name, orders: [...] }
 * display_name = "Table 1" or "Table 1A" / "Table 1B" when multiple phones on same table.
 */
async function getOrdersGroupedByTableAndPhone(tenantId, { statuses = null, limit = 100 } = {}) {
  // Robust limit validation - handle all edge cases
  let finalLimit = 100;
  try {
    const parsed = parseInt(limit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      finalLimit = Math.min(500, parsed);
    }
  } catch (_) {
    finalLimit = 100;
  }

  const where = ['o.tenant_id = ?'];
  const params = [tenantId];

  if (statuses && statuses.length) {
    where.push(`o.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }

  // Get all relevant orders with table info and customer_phone
  const rows = await query(
    `SELECT o.*, t.name AS table_name, t.qr_token AS table_token
       FROM orders o
       JOIN tables t ON t.id = o.table_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.table_id, o.customer_phone, o.id DESC
      LIMIT ?`,
    [...params, finalLimit]
  );

  // Attach items
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const itemRows = await query(
      `SELECT order_id, id, item_id, name, price, qty, is_veg, notes
         FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids
    );
    const byOrder = new Map();
    for (const it of itemRows) {
      it.line_total = round2(it.price * it.qty);
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }
    for (const r of rows) r.items = byOrder.get(r.id) || [];
  }

  // Group by table_id + customer_phone
  const groups = new Map();
  for (const o of rows) {
    const key = `${o.table_id}|${o.customer_phone || 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        table_id: o.table_id,
        table_name: o.table_name,
        table_token: o.table_token,
        phone: o.customer_phone || null,
        orders: []
      });
    }
    groups.get(key).orders.push(o);
  }

  // Assign display names: Table 1, Table 1A, Table 1B...
  const tablePhoneCount = new Map();
  for (const g of groups.values()) {
    const base = g.table_name;
    const phoneKey = g.phone || 'unknown';
    const count = tablePhoneCount.get(base) || 0;
    tablePhoneCount.set(base, count + 1);
    if (count === 0) {
      g.display_name = base; // First phone on this table = "Table 1"
    } else {
      const suffix = String.fromCharCode(65 + count); // A, B, C...
      g.display_name = `${base}${suffix}`; // "Table 1A", "Table 1B"
    }
  }

  return Array.from(groups.values());
}

module.exports = {
  createOrder,
  transitionOrder,
  getOrderWithItems,
  getCustomerOrder,
  getOrdersGroupedByTableAndPhone,
  decorateForCustomer,
  listOrders,
  httpError,
};

/** Add the customer-facing progress helper (which step they are on). */
function decorateForCustomer(order) {
  const stepIndex = CUSTOMER_FLOW.indexOf(order.status);
  const isCancelled = order.status === ORDER_STATUS.CANCELLED;
  return {
    ...order,
    status_label: STATUS_LABEL[order.status],
    is_cancelled: isCancelled,
    progress: {
      steps: CUSTOMER_FLOW.map((s, i) => ({
        key: s,
        label: STATUS_LABEL[s],
        done: !isCancelled && i <= stepIndex,
        current: !isCancelled && i === stepIndex,
      })),
      percent: isCancelled ? 0 : Math.round(((stepIndex + 1) / CUSTOMER_FLOW.length) * 100),
    },
  };
}

/** List orders for a restaurant board. `statuses` filters to open/closed sets. */
async function listOrders(tenantId, { statuses = null, tableId = null, limit = 100 } = {}) {
  const where = ['o.tenant_id = ?'];
  const params = [tenantId];

  if (statuses && statuses.length) {
    where.push(`o.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (tableId) {
    where.push('o.table_id = ?');
    params.push(tableId);
  }

  const rows = await query(
    `SELECT o.*, t.name AS table_name, t.qr_token AS table_token
       FROM orders o
       JOIN tables t ON t.id = o.table_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.id DESC
      LIMIT ?`,
    [...params, limit]
  );

  // Attach items in a single extra query to avoid N+1.
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const itemRows = await query(
      `SELECT order_id, id, item_id, name, price, qty, is_veg, notes
         FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids
    );
    const byOrder = new Map();
    for (const it of itemRows) {
      it.line_total = round2(it.price * it.qty);
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }
    for (const r of rows) r.items = byOrder.get(r.id) || [];
  }
  return rows;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  createOrder,
  transitionOrder,
  getOrderWithItems,
  getCustomerOrder,
  decorateForCustomer,
  listOrders,
  httpError,
};
