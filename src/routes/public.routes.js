'use strict';

const express = require('express');
const { query, get } = require('../config/db');
const { createOrder, getCustomerOrder, decorateForCustomer } = require('../services/orders');
const { OPEN_STATUSES } = require('../utils/constants');

const router = express.Router();

/**
 * Resolve a table by its QR token. Anonymous (no login) by design.
 */
async function resolveTable(token) {
  if (!token) return null;
  return get(
    `SELECT t.id AS table_id, t.name AS table_name, t.seats, t.tenant_id,
            tn.name AS restaurant, tn.currency, tn.gst_percent, tn.phone, tn.address
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
      `SELECT id, category_id, name, description, price, image_url, is_veg, is_available
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
        WHERE table_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
        ORDER BY id DESC`,
      [table.table_id, ...OPEN_STATUSES]
    );

    res.json({
      restaurant: {
        name: table.restaurant,
        currency: table.currency || '₹',
        gst_percent: table.gst_percent,
        phone: table.phone,
        address: table.address,
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
      `SELECT id FROM orders WHERE table_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY id`,
      [table.table_id, ...OPEN_STATUSES]
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

module.exports = router;
