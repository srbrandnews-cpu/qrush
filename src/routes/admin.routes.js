'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, get, run, transaction } = require('../config/db');
const { requireAuth, requireRole, requireSuperAdmin } = require('../middleware/auth');
const { OPEN_STATUSES } = require('../utils/constants');
const { baseUrl, qrDataUrl } = require('../utils/qr');
const notify = require('../services/notify');

const router = express.Router();

/* ========================= SUPER-ADMIN ROUTES (platform-wide) ========================= */
// These run BEFORE the tenant-scoped middleware, so they only need super-admin auth.

function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function uniqueSlug(base) {
  let slug = base || 'restaurant';
  let n = 1;
  while (await get('SELECT id FROM tenants WHERE slug = ?', [slug])) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

// All super-admin routes require platform owner authentication
router.use('/super-admin', requireAuth, requireSuperAdmin);

router.get('/super-admin/tenants', async (req, res, next) => {
  try {
    const tenants = await query(`
      SELECT t.*, u.name as owner_name, u.email as owner_email
      FROM tenants t
      LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'owner' AND u.is_active = 1
      ORDER BY t.created_at DESC
    `);
    res.json({ tenants });
  } catch (err) {
    next(err);
  }
});

router.post('/super-admin/tenants', async (req, res, next) => {
  try {
    const { restaurant, name, email, password, phone } = req.body || {};
    if (!restaurant || !name || !email || !password) {
      return res.status(400).json({ error: 'Restaurant name, owner name, email and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (await get('SELECT id FROM users WHERE email = ?', [String(email).toLowerCase()])) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const slug = await uniqueSlug(slugify(restaurant));
    const hash = bcrypt.hashSync(String(password), 10);

    const result = await transaction(async () => {
      const t = await run(
        'INSERT INTO tenants (name, slug, phone) VALUES (?, ?, ?)',
        [String(restaurant).trim(), slug, phone ? String(phone).trim() : null]
      );
      const tenantId = t.lastInsertRowid;
      const u = await run(
        'INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
        [tenantId, String(name).trim(), String(email).toLowerCase(), hash, 'owner']
      );
      return { tenantId, userId: u.lastInsertRowid };
    });

    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [result.tenantId]);
    const owner = await get('SELECT id, name, email, role FROM users WHERE id = ?', [result.userId]);

    res.status(201).json({ tenant, owner });
  } catch (err) {
    next(err);
  }
});

router.patch('/super-admin/tenants/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, is_active } = req.body || {};

    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [id]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(String(name).trim()); }
    if (phone !== undefined) { updates.push('phone = ?'); params.push(phone ? String(phone).trim() : null); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    await run(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`, params);

    const updated = await get('SELECT * FROM tenants WHERE id = ?', [id]);
    res.json({ tenant: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/super-admin/tenants/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [id]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    if (Number(id) === 1) {
      return res.status(400).json({ error: 'Demo tenant cannot be deleted' });
    }

    await run('DELETE FROM tenants WHERE id = ?', [id]);
    res.json({ ok: true, deleted: id });
  } catch (err) {
    next(err);
  }
});

/* ========================= TENANT-SCOPED ADMIN ROUTES ========================= */
// These require the user to be an 'owner' of their tenant.
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
    const prep = b.prep_minutes !== undefined ? Number(b.prep_minutes) : (t.prep_minutes || 15);
    if (!Number.isFinite(prep) || prep < 1 || prep > 120) {
      return res.status(400).json({ error: 'Typical prep time must be between 1 and 120 minutes' });
    }
    await run(
      `UPDATE tenants SET
         name = ?, phone = ?, address = ?, currency = ?, gst_percent = ?,
         wifi_name = ?, wifi_password = ?, upi_id = ?, rush_mode = ?, prep_minutes = ?
       WHERE id = ?`,
      [
        b.name != null ? String(b.name).trim() : t.name,
        b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : t.phone,
        b.address !== undefined ? (b.address ? String(b.address).trim() : null) : t.address,
        b.currency != null ? String(b.currency).trim() : t.currency,
        gst,
        b.wifi_name !== undefined ? (b.wifi_name ? String(b.wifi_name).trim() : null) : t.wifi_name,
        b.wifi_password !== undefined ? (b.wifi_password ? String(b.wifi_password).trim() : null) : t.wifi_password,
        b.upi_id !== undefined ? (b.upi_id ? String(b.upi_id).trim() : null) : t.upi_id,
        b.rush_mode != null ? (b.rush_mode ? 1 : 0) : t.rush_mode,
        prep,
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

/**
 * GET /api/admin/feedback -> customer ratings (emoji feedback) with summary.
 */
router.get('/feedback', async (req, res, next) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const feedback = await query(
      `SELECT o.id, o.order_no, o.rating, o.feedback, o.customer_name, o.updated_at,
              t.name AS table_name
         FROM orders o JOIN tables t ON t.id = o.table_id
        WHERE o.tenant_id = ? AND o.rating IS NOT NULL
        ORDER BY o.id DESC LIMIT ?`,
      [req.user.tenant_id, limit]
    );
    const summary = await get(
      `SELECT COALESCE(AVG(rating), 0) AS avg_rating, COUNT(rating) AS count
         FROM orders WHERE tenant_id = ? AND rating IS NOT NULL`,
      [req.user.tenant_id]
    );
    res.json({
      feedback,
      summary: {
        avg: Math.round(Number(summary.avg_rating || 0) * 10) / 10,
        count: Number(summary.count) || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/staff-screens
 * Links (and QR codes) for the kitchen and cash-counter screens, so the owner
 * can share them with staff or print them for a tablet.
 */
router.get('/staff-screens', async (req, res, next) => {
  try {
    const base = baseUrl();
    const kitchen = `${base}/kitchen`;
    const cashier = `${base}/cashier`;
    res.json({
      screens: [
        { key: 'kitchen', title: 'Kitchen Display', icon: '👨‍🍳', url: kitchen, qr: await qrDataUrl(kitchen, { scale: 4 }) },
        { key: 'cashier', title: 'Cash Counter', icon: '💰', url: cashier, qr: await qrDataUrl(cashier, { scale: 4 }) },
      ],
    });
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
