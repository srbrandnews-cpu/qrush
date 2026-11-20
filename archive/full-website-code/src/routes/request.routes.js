'use strict';

const express = require('express');
const { query, get, run, utcNow } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { emitToTenant } = require('../realtime/socket');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/requests?status=open|done|all
 * Live service requests for the staff screens (kitchen + cashier + owner).
 */
router.get('/', async (req, res, next) => {
  try {
    const status = req.query.status || 'open';
    const where = ['r.tenant_id = ?'];
    const params = [req.user.tenant_id];
    if (status === 'open' || status === 'done') {
      where.push('r.status = ?');
      params.push(status);
    }

    const requests = await query(
      `SELECT r.*, t.name AS table_name
         FROM table_requests r
         JOIN tables t ON t.id = r.table_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.id DESC
        LIMIT 50`,
      params
    );

    const openRow = await get(
      "SELECT COUNT(*) AS c FROM table_requests WHERE tenant_id = ? AND status = 'open'",
      [req.user.tenant_id]
    );

    res.json({ requests, open: openRow.c });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/requests/:id/resolve
 * Any staff member can mark a request done (water delivered, bill printed ...).
 */
router.patch('/:id/resolve', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Request not found' });

    const request = await get('SELECT * FROM table_requests WHERE id = ? AND tenant_id = ?', [id, req.user.tenant_id]);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    if (request.status !== 'done') {
      await run(
        "UPDATE table_requests SET status = 'done', resolved_at = ?, resolved_by = ? WHERE id = ?",
        [utcNow(), req.user.email || req.user.role || 'staff', id]
      );
    }

    const updated = await get(
      `SELECT r.*, t.name AS table_name
         FROM table_requests r JOIN tables t ON t.id = r.table_id
        WHERE r.id = ?`,
      [id]
    );
    emitToTenant(req.user.tenant_id, 'request:update', { request: updated });
    res.json({ request: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
