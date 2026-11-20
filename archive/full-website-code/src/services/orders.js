'use strict';

const { query, get, run, transaction, utcNow } = require('../config/db');
const { ORDER_STATUS, OPEN_STATUSES, TRANSITIONS, TRANSITION_ROLE, CUSTOMER_FLOW, STATUS_LABEL } = require('../utils/constants');
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

/* ---------------------------------------------------------------------------
 * Bills. One bill = one table + one customer phone. Two different phones on
 * the same table are two separate bills, shown as "Table 1", "Table 1A",
 * "Table 1B" ... (the letter marks the 2nd, 3rd ... open bill on that table).
 * ------------------------------------------------------------------------- */

// A bill stays open while any of its orders is active (served = still unpaid).
const BILL_ACTIVE_STATUSES = [...OPEN_STATUSES, ORDER_STATUS.SERVED];

/** Stable identity for a bill: the phone if we have one, else the device.
 *  Paid/cancelled orders are never merged with others — each becomes its own
 *  bill so a closed bill never accidentally swallows a later order. */
function billKey(order) {
  const status = String(order && order.status || '').toLowerCase();
  if (status === 'paid' || status === 'cancelled') return `order:${order.id}`;
  const phone = cleanPhone(order.customer_phone);
  if (phone) return `phone:${phone}`;
  if (order.device_id) return `device:${order.device_id}`;
  return `order:${order.id}`;
}

/** 0 -> "", 1 -> "A", 26 -> "Z", 27 -> "AA" (Excel-style suffixes). */
function billSuffix(index) {
  let n = index;
  let s = '';
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/**
 * Canonical phone shape so "+91 91729 41524", "091729 41524" and
 * "9172941524" all resolve to the same bill identity. India is the default
 * market, but other country numbers are kept intact.
 */
function cleanPhone(value) {
  if (value === null || value === undefined) return null;
  let digits = String(value).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = digits.slice(2); // international prefix
  if (digits.length === 13 && digits.startsWith('091')) digits = digits.slice(3);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  return digits || null;
}

/**
 * Labels for every bill still open in this restaurant. Recomputed from live
 * orders, so a label is free again once its bill is paid and closed.
 */
async function getActiveBillLabels(tenantId) {
  const rows = await query(
    `SELECT o.id, o.table_id, o.customer_phone, o.device_id, t.name AS table_name
       FROM orders o
       JOIN tables t ON t.id = o.table_id
      WHERE o.tenant_id = ?
        AND o.status IN (${BILL_ACTIVE_STATUSES.map(() => '?').join(',')})
      ORDER BY o.id ASC`,
    [tenantId, ...BILL_ACTIVE_STATUSES]
  );

  const tables = new Map(); // table_id -> Map(bill key -> { key, firstId, table_name })
  for (const row of rows) {
    if (!tables.has(row.table_id)) tables.set(row.table_id, new Map());
    const bills = tables.get(row.table_id);
    const key = billKey(row);
    if (!bills.has(key)) bills.set(key, { key, firstId: row.id, table_name: row.table_name });
  }

  const labels = new Map(); // `${table_id}|${bill key}` -> "Table 1A"
  for (const [tableId, bills] of tables) {
    const ordered = [...bills.values()].sort((a, b) => a.firstId - b.firstId);
    ordered.forEach((bill, index) => {
      labels.set(`${tableId}|${bill.key}`, `${bill.table_name}${billSuffix(index)}`);
    });
  }
  return labels;
}

/** Attach `bill_key` + `bill_label` to orders (table name when no open bill). */
function applyBillLabels(orders, labels) {
  for (const order of orders) {
    const key = billKey(order);
    order.bill_key = key;
    order.bill_label = labels.get(`${order.table_id}|${key}`) || order.table_name || 'Table';
  }
  return orders;
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
  const { tenantId, tableId, items, customerName, customerPhone, deviceId, notes, isParcel, orderType, pickupTime } = payload;

  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Cart is empty');
  }

  // The phone identifies the bill, so keep it clean and sane. Also repair the
  // add-on case from older clients: if this device already has an open order
  // without a phone, backfill it so both orders land in the same bill.
  let phone = cleanPhone(customerPhone);
  if (deviceId) {
    const previous = await get(
      `SELECT id, customer_phone FROM orders
        WHERE table_id = ? AND device_id = ?
          AND status IN (${BILL_ACTIVE_STATUSES.map(() => '?').join(',')})
        ORDER BY id DESC LIMIT 1`,
      [tableId, deviceId, ...BILL_ACTIVE_STATUSES]
    );
    if (!phone) phone = cleanPhone(previous && previous.customer_phone);
    if (phone && previous && !cleanPhone(previous.customer_phone)) {
      await run(
        `UPDATE orders SET customer_phone = ?
          WHERE table_id = ? AND device_id = ?
            AND status IN (${BILL_ACTIVE_STATUSES.map(() => '?').join(',')})
            AND (customer_phone IS NULL OR customer_phone = '')`,
        [phone, tableId, deviceId, ...BILL_ACTIVE_STATUSES]
      );
    }
  }
  if (phone && phone.replace(/\D/g, '').length < 7) {
    throw httpError(400, 'Please enter a valid phone number');
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
          status, item_count, subtotal, gst_amount, total, notes, is_parcel, order_type, pickup_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId, tableId, orderNo,
        customerName || null, phone, deviceId || null,
        ORDER_STATUS.PLACED, itemCount, subtotal, gstAmount, total,
        notes ? notes.toString().slice(0, 300) : null,
        isParcel ? 1 : 0,
        (orderType || (isParcel ? 'takeaway' : 'dinein')).toString().slice(0, 20),
        pickupTime ? pickupTime.toString().slice(0, 40) : null,
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

/** Build a UPI intent link (works with GPay / PhonePe / Paytm, no gateway). */
function upiLink({ upiId, merchant, amount, note }) {
  const params = [
    `pa=${encodeURIComponent(upiId)}`,
    `pn=${encodeURIComponent(merchant || 'Restaurant')}`,
    `am=${encodeURIComponent(Number(amount).toFixed(2))}`,
    'cu=INR',
  ];
  if (note) params.push(`tn=${encodeURIComponent(note)}`);
  return `upi://pay?${params.join('&')}`;
}

/** Live status for the customer (no login needed). */
async function getCustomerOrder(tableToken, orderId) {
  const order = await getOrderWithItems(orderId);
  if (!order) return null;
  if (order.table_token !== tableToken) return null; // prevent ID guessing across tables

  const decorated = decorateForCustomer(order);
  const tenant = await get('SELECT name, upi_id, prep_minutes FROM tenants WHERE id = ?', [order.tenant_id]);
  const prep = Number(tenant && tenant.prep_minutes) || 15;
  decorated.prep_minutes = prep;

  // Live queue position + ETA while the kitchen is still working on it.
  if ([ORDER_STATUS.PLACED, ORDER_STATUS.ACCEPTED, ORDER_STATUS.PREPARING].includes(order.status)) {
    const ahead = await get(
      `SELECT COUNT(*) AS c FROM orders
        WHERE tenant_id = ? AND id < ? AND status IN (?, ?, ?)`,
      [order.tenant_id, order.id, ORDER_STATUS.PLACED, ORDER_STATUS.ACCEPTED, ORDER_STATUS.PREPARING]
    );
    const position = Number(ahead && ahead.c ? ahead.c : 0) + 1;
    const created = Date.parse(String(order.created_at).replace(' ', 'T') + 'Z');
    const elapsed = Number.isFinite(created) ? Math.max(0, Math.floor((Date.now() - created) / 60000)) : 0;
    decorated.queue = {
      position,
      ahead: position - 1,
      eta_minutes: Math.max(1, prep - elapsed + (position - 1) * 3),
    };
  }

  // Pay-from-phone link once the order is ready/served and still unpaid.
  if (tenant && tenant.upi_id && order.payment_status !== 'paid' && ['ready', 'served'].includes(order.status)) {
    decorated.upi = {
      id: tenant.upi_id,
      merchant: tenant.name,
      amount: round2(Number(order.total) || 0),
      link: upiLink({ upiId: tenant.upi_id, merchant: tenant.name, amount: order.total, note: `${order.table_name} bill` }),
    };
  }

  return decorated;
}

/**
 * Orders grouped into bills: one bill = one table + one customer phone.
 * Returns [{ table_id, table_name, display_name, phone, orders, total, ... }]
 * where display_name is "Table 1" / "Table 1A" / "Table 1B" ...
 */
async function getOrdersGroupedByTableAndPhone(tenantId, { statuses = null, tableId = null, limit = 100 } = {}) {
  const parsedLimit = parseInt(limit, 10);
  const rows = await listOrders(tenantId, {
    statuses,
    tableId,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(500, parsedLimit) : 100,
  });

  const groups = new Map();
  for (const order of rows) {
    const key = `${order.table_id}|${order.bill_key}`;
    if (!groups.has(key)) {
      groups.set(key, {
        table_id: order.table_id,
        table_name: order.table_name,
        table_token: order.table_token,
        bill_key: order.bill_key,
        display_name: order.bill_label,
        phone: order.customer_phone || null,
        customer_name: order.customer_name || null,
        orders: [],
        total: 0,
        item_count: 0,
      });
    }
    const group = groups.get(key);
    group.orders.push(order);
    group.total = round2(group.total + Number(order.total || 0));
    group.item_count += Number(order.item_count || 0);
    if (!group.phone && order.customer_phone) group.phone = order.customer_phone;
    if (!group.customer_name && order.customer_name) group.customer_name = order.customer_name;
  }

  return [...groups.values()].sort((a, b) =>
    String(a.display_name).localeCompare(String(b.display_name), undefined, { numeric: true })
  );
}

/** Add the customer-facing progress helper (which step they are on). */
function decorateForCustomer(order) {
  const stepIndex = CUSTOMER_FLOW.indexOf(order.status);
  const isCancelled = order.status === ORDER_STATUS.CANCELLED;
  return {
    ...order,
    bill_key: billKey(order),
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

  applyBillLabels(rows, await getActiveBillLabels(tenantId));
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
  getOrdersGroupedByTableAndPhone,
  getActiveBillLabels,
  applyBillLabels,
  billKey,
  cleanPhone,
  decorateForCustomer,
  listOrders,
  httpError,
};
