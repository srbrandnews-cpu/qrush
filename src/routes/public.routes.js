'use strict';

const express = require('express');
const { query, get, run } = require('../config/db');
const { createOrder, getCustomerOrder, decorateForCustomer } = require('../services/orders');
const { OPEN_STATUSES, REQUEST_TYPES, REQUEST_LABELS } = require('../utils/constants');
const { emitToTenant } = require('../realtime/socket');

const router = express.Router();

// What the customer still sees on their phone: the kitchen steps plus served
// (so they can pay by UPI and leave a rating before the cashier closes the bill).
const CUSTOMER_ACTIVE = [...OPEN_STATUSES, 'served'];

/**
 * Resolve a table by its QR token. Anonymous (no login) by design.
 */
async function resolveTable(token) {
  if (!token) return null;
  return get(
    `SELECT t.id AS table_id, t.name AS table_name, t.seats, t.tenant_id,
            tn.name AS restaurant, tn.slug, tn.currency, tn.gst_percent, tn.phone, tn.address,
            tn.wifi_name, tn.wifi_password, tn.upi_id, tn.rush_mode, tn.prep_minutes
       FROM tables t
       JOIN tenants tn ON tn.id = t.tenant_id
      WHERE t.qr_token = ? AND t.is_active = 1 AND tn.is_active = 1`,
    [String(token)]
  );
}

/**
 * GET /api/public/menu?table=<qr_token>
 * Everything the customer's menu screen needs.
 */
router.get('/menu', async (req, res, next) => {
  try {
    const table = await resolveTable(req.query.table);
    if (!table) return res.status(404).json({ error: 'Invalid or inactive table QR code' });

    const categories = await query(
      'SELECT id, name, sort_order FROM menu_categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, id',
      [table.tenant_id]
    );
    const items = await query(
      `SELECT id, category_id, name, description, price, image_url, is_veg, is_available, is_quick
         FROM menu_items WHERE tenant_id = ? AND is_available = 1 ORDER BY sort_order, id`,
      [table.tenant_id]
    );

    const menu = categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: items.filter((i) => i.category_id === c.id),
    }));
    const uncategorized = items.filter((i) => !i.category_id || !categories.some((c) => c.id === i.category_id));
    if (uncategorized.length) menu.push({ id: null, name: 'More', items: uncategorized });

    // Any open orders already on this table (so a returning phone sees status).
    const active = await query(
      `SELECT id, order_no, status, created_at FROM orders
        WHERE table_id = ? AND status IN (${CUSTOMER_ACTIVE.map(() => '?').join(',')})
        ORDER BY id DESC`,
      [table.table_id, ...CUSTOMER_ACTIVE]
    );

    res.json({
      restaurant: {
        name: table.restaurant,
        slug: table.slug,
        currency: table.currency || '₹',
        gst_percent: table.gst_percent,
        phone: table.phone,
        address: table.address,
        wifi_name: table.wifi_name,
        wifi_password: table.wifi_password,
        upi_id: table.upi_id,
        rush_mode: Number(table.rush_mode) || 0,
        prep_minutes: Number(table.prep_minutes) || 15,
      },
      table: { name: table.table_name, seats: table.seats, token: req.query.table },
      menu,
      activeOrders: active,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/public/orders
 * body: { table, items:[{item_id, qty, notes}], customerName, customerPhone, deviceId, notes }
 */
router.post('/orders', async (req, res, next) => {
  try {
    const b = req.body || {};
    const table = await resolveTable(b.table);
    if (!table) return res.status(404).json({ error: 'Invalid or inactive table QR code' });

    const order = await createOrder({
      tenantId: table.tenant_id,
      tableId: table.table_id,
      items: b.items,
      customerName: b.customerName,
      customerPhone: b.customerPhone,
      deviceId: b.deviceId,
      notes: b.notes,
    });

    res.status(201).json({ order: decorateForCustomer(order) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * GET /api/public/orders/:id?table=<qr_token>  -> live status for the customer.
 */
router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await getCustomerOrder(String(req.query.table || ''), Number(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/public/tables/:token/orders  -> all open orders on this table.
 * Lets a customer reopen the page later and still track their food.
 */
router.get('/tables/:token/orders', async (req, res, next) => {
  try {
    const table = await resolveTable(req.params.token);
    if (!table) return res.status(404).json({ error: 'Invalid table' });

    const rows = await query(
      `SELECT id FROM orders WHERE table_id = ? AND status IN (${CUSTOMER_ACTIVE.map(() => '?').join(',')}) ORDER BY id`,
      [table.table_id, ...CUSTOMER_ACTIVE]
    );
    const orders = [];
    for (const r of rows) {
      const o = await getCustomerOrder(req.params.token, r.id);
      if (o) orders.push(o);
    }
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/public/requests  { table, type }
 * One-tap "water / spoon / bill / AC / waiter" from the customer's phone.
 * Repeated taps within 3 minutes reuse the same open request (no spam).
 */
router.post('/requests', async (req, res, next) => {
  try {
    const b = req.body || {};
    const table = await resolveTable(b.table);
    if (!table) return res.status(404).json({ error: 'Invalid or inactive table QR code' });

    const type = String(b.type || '').toLowerCase();
    if (!REQUEST_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown request type' });

    const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const existing = await get(
      `SELECT r.*, t.name AS table_name FROM table_requests r
         JOIN tables t ON t.id = r.table_id
        WHERE r.table_id = ? AND r.type = ? AND r.status = 'open' AND r.created_at >= ?
        ORDER BY r.id DESC LIMIT 1`,
      [table.table_id, type, cutoff]
    );
    if (existing) {
      existing.label = REQUEST_LABELS[type] || type;
      return res.json({ request: existing, duplicate: true });
    }

    const r = await run(
      'INSERT INTO table_requests (tenant_id, table_id, type) VALUES (?, ?, ?)',
      [table.tenant_id, table.table_id, type]
    );
    const request = await get(
      `SELECT r.*, t.name AS table_name FROM table_requests r
         JOIN tables t ON t.id = r.table_id WHERE r.id = ?`,
      [r.lastInsertRowid]
    );
    request.label = REQUEST_LABELS[type] || type;
    emitToTenant(table.tenant_id, 'request:new', { request });
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/public/requests?table=<qr_token>
 * Open requests for this table, so the phone can show "already requested".
 */
router.get('/requests', async (req, res, next) => {
  try {
    const table = await resolveTable(req.query.table);
    if (!table) return res.status(404).json({ error: 'Invalid or inactive table QR code' });
    const requests = await query(
      "SELECT id, type, status, created_at FROM table_requests WHERE table_id = ? AND status = 'open' ORDER BY id DESC",
      [table.table_id]
    );
    res.json({ requests, types: REQUEST_TYPES, labels: REQUEST_LABELS });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/public/orders/:id/feedback  { table, rating, comment }
 * Emoji rating + optional note, once the food has reached the table.
 */
router.post('/orders/:id/feedback', async (req, res, next) => {
  try {
    const b = req.body || {};
    const table = await resolveTable(b.table);
    if (!table) return res.status(404).json({ error: 'Invalid or inactive table QR code' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Order not found' });
    const order = await get('SELECT * FROM orders WHERE id = ? AND table_id = ? AND tenant_id = ?', [
      id, table.table_id, table.tenant_id,
    ]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['ready', 'served', 'paid'].includes(order.status)) {
      return res.status(400).json({ error: 'You can rate once your food is served' });
    }

    const rating = Math.round(Number(b.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    const comment = b.comment != null ? String(b.comment).trim().slice(0, 300) : null;

    await run('UPDATE orders SET rating = ?, feedback = ? WHERE id = ?', [rating, comment || null, id]);
    emitToTenant(table.tenant_id, 'feedback:new', { order_id: id, rating, comment });
    res.json({ ok: true, rating, comment });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/public/venue/:slug
 * Public live wait-time for a restaurant (used by /r/:slug).
 */
router.get('/venue/:slug', async (req, res, next) => {
  try {
    const tn = await get(
      'SELECT id, name, slug, phone, address, prep_minutes, currency FROM tenants WHERE slug = ? AND is_active = 1',
      [String(req.params.slug)]
    );
    if (!tn) return res.status(404).json({ error: 'Restaurant not found' });

    const openRow = await get(
      `SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
      [tn.id, ...OPEN_STATUSES]
    );
    const tablesRow = await get('SELECT COUNT(*) AS c FROM tables WHERE tenant_id = ? AND is_active = 1', [tn.id]);
    const queue = Number(openRow.c) || 0;
    const tables = Number(tablesRow.c) || 1;
    const prep = Number(tn.prep_minutes) || 15;
    const eta = queue === 0 ? 0 : Math.max(2, Math.round((queue / Math.max(1, tables)) * prep + prep / 2));

    res.json({
      restaurant: { name: tn.name, slug: tn.slug, phone: tn.phone, address: tn.address, currency: tn.currency || '₹' },
      queue,
      tables,
      eta_minutes: eta,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
