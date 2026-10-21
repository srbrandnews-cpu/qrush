'use strict';

const crypto = require('crypto');
const express = require('express');
const { query, get, run } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { menuUrl, menuQrDataUrl } = require('../utils/qr');

const router = express.Router();
router.use(requireAuth, requireRole('owner'));

function newToken() {
  return crypto.randomBytes(9).toString('base64url'); // short + URL-safe
}

async function ownedTable(tenantId, id) {
  return get('SELECT * FROM tables WHERE id = ? AND tenant_id = ?', [Number(id), tenantId]);
}

function withUrl(t) {
  return { ...t, menu_url: menuUrl(t.qr_token) };
}

/**
 * GET /api/tables
 */
router.get('/', async (req, res, next) => {
  try {
    const rows = (await query(
      'SELECT * FROM tables WHERE tenant_id = ? ORDER BY id',
      [req.user.tenant_id]
    )).map(withUrl);
    res.json({ tables: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tables  { name, seats }
 */
router.post('/', async (req, res, next) => {
  try {
    const { name, seats } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Table name/number is required' });
    const r = await run(
      'INSERT INTO tables (tenant_id, name, seats, qr_token) VALUES (?, ?, ?, ?)',
      [req.user.tenant_id, String(name).trim(), Math.max(1, Number(seats) || 4), newToken()]
    );
    res.status(201).json(withUrl(await get('SELECT * FROM tables WHERE id = ?', [r.lastInsertRowid])));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tables/bulk  { count, startNumber, seats }
 * Handy when a restaurant has 20+ tables to set up.
 */
router.post('/bulk', async (req, res, next) => {
  try {
    const count = Math.min(200, Math.max(1, parseInt(req.body && req.body.count, 10) || 1));
    const start = Math.max(1, parseInt(req.body && req.body.startNumber, 10) || 1);
    const seats = Math.max(1, Number(req.body && req.body.seats) || 4);
    const created = [];
    for (let i = 0; i < count; i++) {
      const r = await run(
        'INSERT INTO tables (tenant_id, name, seats, qr_token) VALUES (?, ?, ?, ?)',
        [req.user.tenant_id, `Table ${start + i}`, seats, newToken()]
      );
      created.push(r.lastInsertRowid);
    }
    res.status(201).json({ created: created.length });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/tables/:id  { name, seats, is_active }
 */
router.put('/:id', async (req, res, next) => {
  try {
    const table = await ownedTable(req.user.tenant_id, req.params.id);
    if (!table) return res.status(404).json({ error: 'Table not found' });
    const b = req.body || {};
    await run(
      'UPDATE tables SET name = ?, seats = ?, is_active = ? WHERE id = ?',
      [
        b.name != null ? String(b.name).trim() : table.name,
        Number.isFinite(Number(b.seats)) ? Number(b.seats) : table.seats,
        b.is_active != null ? (b.is_active ? 1 : 0) : table.is_active,
        table.id,
      ]
    );
    res.json(withUrl(await get('SELECT * FROM tables WHERE id = ?', [table.id])));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/tables/:id
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const table = await ownedTable(req.user.tenant_id, req.params.id);
    if (!table) return res.status(404).json({ error: 'Table not found' });
    await run('DELETE FROM tables WHERE id = ?', [table.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tables/:id/qr -> PNG data-URL for a single table's sticker.
 */
router.get('/:id/qr', async (req, res, next) => {
  try {
    const table = await ownedTable(req.user.tenant_id, req.params.id);
    if (!table) return res.status(404).json({ error: 'Table not found' });
    const dataUrl = await menuQrDataUrl(table.qr_token);
    res.json({ table: withUrl(table), qr: dataUrl });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/tables/qr-sheet -> every table's QR as a data-URL (for printing).
 * Uses /qr-sheet explicitly so it doesn't clash with the /:id routes.
 */
router.get('/qr-sheet', async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM tables WHERE tenant_id = ? ORDER BY id', [req.user.tenant_id]);
    const sheet = [];
    for (const t of rows) {
      sheet.push({ ...withUrl(t), qr: await menuQrDataUrl(t.qr_token, { scale: 4 }) });
    }
    const restaurant = await get('SELECT name FROM tenants WHERE id = ?', [req.user.tenant_id]);
    res.json({ restaurant, tables: sheet });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
