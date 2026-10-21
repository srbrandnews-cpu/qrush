'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, get, run } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { OPEN_STATUSES } = require('../utils/constants');
const notify = require('../services/notify');

const router = express.Router();
router.use(requireAuth, requireRole('owner'));

/**
 * GET /api/admin/overview -> counts for the owner dashboard.
 */
router.get('/overview', async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const tables = (await get('SELECT COUNT(*) AS c FROM tables WHERE tenant_id = ?', [tenantId])).c;
    const menuItems = (await get('SELECT COUNT(*) AS c FROM menu_items WHERE tenant_id = ?', [tenantId])).c;
    const staff = (await get("SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND role != 'owner'", [tenantId])).c;
    const open = (await get(
      `SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
      [tenantId, ...OPEN_STATUSES]
    )).c;
    const allOrders = (await get('SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ?', [tenantId])).c;
    res.json({ tables, menuItems, staff, openOrders: open, allOrders });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/restaurant
 */
router.get('/restaurant', async (req, res, next) => {
  try {
    res.json({ restaurant: await get('SELECT * FROM tenants WHERE id = ?', [req.user.tenant_id]) });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/restaurant  { name, phone, address, currency, gst_percent }
 */
router.put('/restaurant', async (req, res, next) => {
  try {
    const t = await get('SELECT * FROM tenants WHERE id = ?', [req.user.tenant_id]);
    const b = req.body || {};
    const gst = b.gst_percent !== undefined ? Number(b.gst_percent) : t.gst_percent;
    if (!Number.isFinite(gst) || gst < 0 || gst > 100) {
      return res.status(400).json({ error: 'GST percent must be between 0 and 100' });
    }
    await run(
      'UPDATE tenants SET name = ?, phone = ?, address = ?, currency = ?, gst_percent = ? WHERE id = ?',
      [
        b.name != null ? String(b.name).trim() : t.name,
        b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : t.phone,
        b.address !== undefined ? (b.address ? String(b.address).trim() : null) : t.address,
        b.currency != null ? String(b.currency).trim() : t.currency,
        gst,
        t.id,
      ]
    );
    res.json({ restaurant: await get('SELECT * FROM tenants WHERE id = ?', [t.id]) });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/notifications-settings  { country_code, notify_channels }
 * Only browser push is supported (WhatsApp/SMS were removed).
 */
router.put('/notifications-settings', async (req, res, next) => {
  try {
    const t = await get('SELECT * FROM tenants WHERE id = ?', [req.user.tenant_id]);
    const b = req.body || {};

    let countryCode = t.country_code || '+91';
    if (b.country_code != null) {
      const cc = String(b.country_code).trim();
      if (!/^\+?\d{1,4}$/.test(cc)) {
        return res.status(400).json({ error: 'Country code must be like +91' });
      }
      countryCode = cc.startsWith('+') ? cc : '+' + cc;
    }

    // 'push' is the only channel left.
    const channels = 'push';

    await run('UPDATE tenants SET country_code = ?, notify_channels = ? WHERE id = ?', [countryCode, channels, t.id]);
    res.json({ restaurant: await get('SELECT * FROM tenants WHERE id = ?', [t.id]) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/notifications -> delivery log (what was sent to whom).
 */
router.get('/notifications', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT n.*, o.order_no, t.name AS table_name
         FROM notifications n
         LEFT JOIN orders o ON o.id = n.order_id
         LEFT JOIN tables t ON t.id = o.table_id
        WHERE n.tenant_id = ?
        ORDER BY n.id DESC
        LIMIT ?`,
      [req.user.tenant_id, Math.min(300, parseInt(req.query.limit, 10) || 100)]
    );
    res.json({ notifications: rows, provider: notify.providerStatus() });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/notifications -> clear the delivery log.
 */
router.delete('/notifications', async (req, res, next) => {
  try {
    await run('DELETE FROM notifications WHERE tenant_id = ?', [req.user.tenant_id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- staff -------------------------------- */

router.get('/staff', async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE tenant_id = ? ORDER BY id',
      [req.user.tenant_id]
    );
    res.json({ staff: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/staff', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (!['owner', 'kitchen', 'cashier'].includes(role)) {
      return res.status(400).json({ error: 'Role must be owner, kitchen or cashier' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const cleanEmail = String(email).toLowerCase();
    if (await get('SELECT id FROM users WHERE email = ?', [cleanEmail])) {
      return res.status(409).json({ error: 'This email is already registered' });
    }
    const r = await run(
      'INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [req.user.tenant_id, String(name).trim(), cleanEmail, bcrypt.hashSync(String(password), 10), role]
    );
    res.status(201).json(await get('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) {
    next(err);
  }
});

router.put('/staff/:id', async (req, res, next) => {
  try {
    const user = await get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [Number(req.params.id), req.user.tenant_id]);
    if (!user) return res.status(404).json({ error: 'Staff member not found' });
    const b = req.body || {};

    if (user.role === 'owner' && (b.role && b.role !== 'owner') && user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own owner role' });
    }
    const role = b.role && ['owner', 'kitchen', 'cashier'].includes(b.role) ? b.role : user.role;

    await run(
      'UPDATE users SET name = ?, role = ?, is_active = ?, password_hash = ? WHERE id = ?',
      [
        b.name != null ? String(b.name).trim() : user.name,
        role,
        b.is_active != null ? (b.is_active ? 1 : 0) : user.is_active,
        b.password ? bcrypt.hashSync(String(b.password), 10) : user.password_hash,
        user.id,
      ]
    );
    res.json(await get('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [user.id]));
  } catch (err) {
    next(err);
  }
});

router.delete('/staff/:id', async (req, res, next) => {
  try {
    const user = await get('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [Number(req.params.id), req.user.tenant_id]);
    if (!user) return res.status(404).json({ error: 'Staff member not found' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    await run('DELETE FROM users WHERE id = ?', [user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
