'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listOrders,
  transitionOrder,
  getOrderWithItems,
  getOrdersGroupedByTableAndPhone,
  getActiveBillLabels,
  applyBillLabels,
} = require('../services/orders');
const { get, query, utcToday } = require('../config/db');
const { OPEN_STATUSES, ORDER_STATUS } = require('../utils/constants');

const router = express.Router();
router.use(requireAuth);

/** Attach "Table 1 / Table 1A" bill labels to a single order. */
async function withBillLabel(order) {
  if (!order) return order;
  return applyBillLabels([order], await getActiveBillLabels(order.tenant_id))[0];
}

/**
 * GET /api/orders?board=open|closed|all&limit=100
 * Kitchen and cashier screens poll/subscribe to this.
 */
router.get('/', async (req, res, next) => {
  try {
    const board = req.query.board || 'open';
    let statuses = null;
    if (board === 'open') statuses = OPEN_STATUSES;
    else if (board === 'closed') statuses = [ORDER_STATUS.SERVED, ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED];

    const orders = await listOrders(req.user.tenant_id, {
      statuses,
      limit: Math.min(500, parseInt(req.query.limit, 10) || 100),
    });
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/stats -> today's numbers for the owner dashboard.
 * Dates are compared with substr(...,1,10) so it works on both SQLite & Postgres.
 */
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const today = utcToday();

    const stats = await get(
      `SELECT
         COUNT(*) AS orders_today,
         COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0) AS revenue_today,
         COALESCE(SUM(CASE WHEN status != 'cancelled' THEN item_count ELSE 0 END), 0) AS items_today
       FROM orders
      WHERE tenant_id = ? AND substr(created_at, 1, 10) = ?`,
      [tenantId, today]
    );

    const byStatus = await queryByStatus(tenantId, today);

    const openRow = await get(
      `SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
      [tenantId, ...OPEN_STATUSES]
    );

    const topItems = await getTopItems(tenantId, today);

    res.json({ today: stats, byStatus, openNow: openRow.count, topItems });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/grouped-by-table-phone
 * Orders grouped into bills (table + customer phone).
 * Each bill gets a display name: "Table 1", "Table 1A", "Table 1B"...
 *
 * NOTE: must stay above GET /:id, otherwise Express matches this path as an id.
 */
router.get('/grouped-by-table-phone', async (req, res, next) => {
  try {
    const board = req.query.board || 'open';
    let statuses = null;
    if (board === 'open') statuses = OPEN_STATUSES;
    else if (board === 'closed') statuses = [ORDER_STATUS.SERVED, ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED];

    const groups = await getOrdersGroupedByTableAndPhone(req.user.tenant_id, {
      statuses,
      limit: Math.min(500, parseInt(req.query.limit, 10) || 100),
    });
    res.json({ groups });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = await getOrderWithItems(id);
    if (!order || order.tenant_id !== req.user.tenant_id) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ order: await withBillLabel(order) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/orders/:id/transition  { to: 'accepted'|'preparing'|'ready'|'served'|'paid'|'cancelled' }
 */
router.post('/:id/transition', async (req, res, next) => {
  try {
    const to = req.body && req.body.to;
    if (!to) return res.status(400).json({ error: 'Target status is required' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const existing = await getOrderWithItems(id);
    if (!existing || existing.tenant_id !== req.user.tenant_id) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = await transitionOrder({
      orderId: existing.id,
      toStatus: to,
      actor: req.user,
      paymentMethod: req.body.payment_method || null,
    });
    res.json({ order: await withBillLabel(order) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

async function queryByStatus(tenantId, today) {
  return query(
    `SELECT status, COUNT(*) AS count FROM orders
      WHERE tenant_id = ? AND substr(created_at, 1, 10) = ? GROUP BY status`,
    [tenantId, today]
  );
}

async function getTopItems(tenantId, today) {
  return query(
    `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.price * oi.qty) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.tenant_id = ? AND substr(o.created_at, 1, 10) = ? AND o.status != 'cancelled'
      GROUP BY oi.name ORDER BY qty DESC LIMIT 5`,
    [tenantId, today]
  );
}

module.exports = router;
