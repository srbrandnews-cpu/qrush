'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, get, run, transaction, dialect, utcToday } = require('../config/db');
const { requireAuth, requireRole, requireSuperAdmin, SUPER_ADMIN_EMAILS } = require('../middleware/auth');
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

/**
 * One row per restaurant with the numbers a platform admin needs. Correlated
 * subqueries keep the shape identical on SQLite and Postgres (a plain JOIN on
 * owners would duplicate a restaurant that has more than one owner account).
 */
async function listPlatformTenants() {
  const today = utcToday();
  const openSlots = OPEN_STATUSES.map(() => '?').join(',');
  const rows = await query(`
    SELECT t.id, t.name, t.slug, t.phone, t.address, t.description, t.opening_hours, t.closing_hours,
           t.whatsapp, t.instagram, t.facebook, t.website,
           t.currency, t.gst_percent, t.is_active, t.created_at, t.upi_id, t.prep_minutes, t.rush_mode,
           t.plan, t.plan_status, t.plan_started_at, t.plan_expires_at,
           (SELECT u.id FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_id,
           (SELECT u.name FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_name,
           (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_email,
           (SELECT tb.qr_token FROM tables tb WHERE tb.tenant_id = t.id AND tb.is_active = 1 ORDER BY tb.id LIMIT 1) AS sample_table_token,
           (SELECT COUNT(*) FROM tables tb WHERE tb.tenant_id = t.id) AS tables_count,
           (SELECT COUNT(*) FROM menu_items mi WHERE mi.tenant_id = t.id) AS menu_count,
           (SELECT COUNT(*) FROM users us WHERE us.tenant_id = t.id AND us.is_active = 1) AS staff_count,
           (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id) AS orders_all,
           (SELECT COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total ELSE 0 END), 0)
              FROM orders o WHERE o.tenant_id = t.id) AS revenue_all,
           (SELECT MAX(o.created_at) FROM orders o WHERE o.tenant_id = t.id) AS last_order_at,
           (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id AND substr(o.created_at, 1, 10) = ?) AS orders_today,
           (SELECT COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total ELSE 0 END), 0)
              FROM orders o WHERE o.tenant_id = t.id AND substr(o.created_at, 1, 10) = ?) AS revenue_today,
           (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id AND o.status IN (${openSlots})) AS open_orders
      FROM tenants t
     ORDER BY t.created_at DESC, t.id DESC
  `, [today, today, ...OPEN_STATUSES]);

  return rows.map((row) => Object.assign({}, row, {
    tables_count: Number(row.tables_count) || 0,
    menu_count: Number(row.menu_count) || 0,
    staff_count: Number(row.staff_count) || 0,
    orders_all: Number(row.orders_all) || 0,
    revenue_all: Number(row.revenue_all) || 0,
    orders_today: Number(row.orders_today) || 0,
    revenue_today: Number(row.revenue_today) || 0,
    open_orders: Number(row.open_orders) || 0,
  }));
}

/**
 * GET /api/admin/super-admin/overview
 * Platform-wide KPIs + every restaurant with live/today/all-time numbers.
 */
router.get('/super-admin/overview', async (req, res, next) => {
  try {
    const today = utcToday();
    const openSlots = OPEN_STATUSES.map(() => '?').join(',');
    const stats = await get(`
      SELECT
        (SELECT COUNT(*) FROM tenants) AS tenants_total,
        (SELECT COUNT(*) FROM tenants WHERE is_active = 1) AS tenants_active,
        (SELECT COUNT(*) FROM tenants WHERE is_active = 0) AS tenants_suspended,
        (SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1) AS owners_total,
        (SELECT COUNT(*) FROM users WHERE role IN ('kitchen', 'cashier') AND is_active = 1) AS staff_total,
        (SELECT COUNT(*) FROM tables WHERE is_active = 1) AS tables_total,
        (SELECT COUNT(*) FROM menu_items) AS menu_items_total,
        (SELECT COUNT(*) FROM orders WHERE substr(created_at, 1, 10) = ?) AS orders_today,
        (SELECT COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0)
           FROM orders WHERE substr(created_at, 1, 10) = ?) AS revenue_today,
        (SELECT COUNT(*) FROM orders) AS orders_all,
        (SELECT COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0)
           FROM orders) AS revenue_all,
        (SELECT COUNT(*) FROM orders WHERE status IN (${openSlots})) AS open_orders,
        (SELECT COUNT(DISTINCT tenant_id) FROM orders WHERE substr(created_at, 1, 10) = ?) AS active_tenants_today,
        (SELECT COUNT(*) FROM tenants WHERE substr(created_at, 1, 10) = ?) AS tenants_new_today,
        (SELECT COALESCE(AVG(rating), 0) FROM orders WHERE rating IS NOT NULL) AS rating_avg,
        (SELECT COUNT(rating) FROM orders WHERE rating IS NOT NULL) AS rating_count,
        (SELECT COUNT(*) FROM tenants WHERE COALESCE(plan,'free') = 'free') AS tenants_plan_free,
        (SELECT COUNT(*) FROM tenants WHERE plan = 'starter') AS tenants_plan_starter,
        (SELECT COUNT(*) FROM tenants WHERE plan = 'business') AS tenants_plan_business,
        (SELECT COUNT(*) FROM free_qr_menus) AS freeqr_total,
        (SELECT COUNT(*) FROM free_qr_menus WHERE COALESCE(plan,'free') = 'free') AS freeqr_plan_free,
        (SELECT COUNT(*) FROM free_qr_menus WHERE plan = 'starter') AS freeqr_plan_starter,
        (SELECT COUNT(*) FROM free_qr_menus WHERE plan = 'business') AS freeqr_plan_business,
        (SELECT COUNT(*) FROM tenant_menu_events WHERE kind = 'view') AS tenant_menu_views,
        (SELECT COUNT(*) FROM free_qr_events WHERE kind = 'view') AS freeqr_menu_views
    `, [today, today, ...OPEN_STATUSES, today, today]);

    const normalized = {};
    Object.keys(stats || {}).forEach((key) => {
      const value = stats[key];
      normalized[key] = value === null || value === undefined ? value : Number(value) || 0;
    });

    const tenants = await listPlatformTenants();
    res.json({
      stats: normalized,
      tenants,
      meta: {
        database: dialect(),
        node: process.version,
        uptime_seconds: Math.round(process.uptime()),
        today,
        super_admins: SUPER_ADMIN_EMAILS,
        demo_access: SUPER_ADMIN_EMAILS.includes('owner@demo.com'),
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/super-admin/tenants', async (req, res, next) => {
  try {
    res.json({ tenants: await listPlatformTenants() });
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
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
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

    if (is_active !== undefined && !is_active && Number(id) === Number(req.user.tenant_id)) {
      return res.status(400).json({ error: 'You cannot suspend your own restaurant workspace' });
    }

    const updates = [];
    const params = [];
    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName) return res.status(400).json({ error: 'Restaurant name cannot be empty' });
      updates.push('name = ?'); params.push(cleanName.slice(0, 80));
    }
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

/**
 * PUT /api/admin/super-admin/tenants/:id/owner
 * Support action: fix the owner's name/email or set a new password.
 * body: { name?, email?, password? }
 */
router.put('/super-admin/tenants/:id/owner', async (req, res, next) => {
  try {
    const { id } = req.params;
    const tenant = await get('SELECT id, name FROM tenants WHERE id = ?', [id]);
    if (!tenant) return res.status(404).json({ error: 'Restaurant not found' });

    const owner = await get(
      "SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' ORDER BY id LIMIT 1",
      [id]
    );
    if (!owner) return res.status(404).json({ error: 'This restaurant has no owner account' });

    const b = req.body || {};
    const updates = [];
    const params = [];

    if (b.name !== undefined) {
      const cleanName = String(b.name).trim();
      if (!cleanName) return res.status(400).json({ error: 'Owner name cannot be empty' });
      updates.push('name = ?'); params.push(cleanName.slice(0, 80));
    }
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'Enter a valid email address' });
      }
      const clash = await get('SELECT id FROM users WHERE email = ? AND id != ?', [email, owner.id]);
      if (clash) return res.status(409).json({ error: 'Another account already uses this email' });
      updates.push('email = ?'); params.push(email);
    }
    if (b.password !== undefined) {
      if (String(b.password).length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
      }
      updates.push('password_hash = ?'); params.push(bcrypt.hashSync(String(b.password), 10));
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(owner.id);
    await run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({
      owner: await get('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [owner.id]),
    });
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
    if (Number(id) === Number(req.user.tenant_id)) {
      return res.status(400).json({ error: 'You cannot delete your own restaurant workspace' });
    }

    await run('DELETE FROM tenants WHERE id = ?', [id]);
    res.json({ ok: true, deleted: id });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/super-admin/free-qr — list all free QR menus with stats.
 */
router.get('/super-admin/free-qr', async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM free_qr_menus ORDER BY id DESC');
    const out = [];
    for (const r of rows) {
      const fqId = r.id;
      const views = await get("SELECT COUNT(*) AS c FROM free_qr_events WHERE free_qr_id = ? AND kind = 'view'", [fqId]);
      const clicks = await get("SELECT COUNT(*) AS c FROM free_qr_events WHERE free_qr_id = ? AND kind IN ('whatsapp','instagram','facebook','website')", [fqId]);
      const orders = await get("SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS s FROM free_qr_orders WHERE free_qr_id = ? AND status <> 'cancelled'", [fqId]);
      const items = await get('SELECT COUNT(*) AS c FROM free_qr_items WHERE free_qr_id = ?', [fqId]);
      out.push({
        id: r.id,
        slug: r.slug,
        restaurant: r.restaurant,
        owner_name: r.owner_name,
        phone: r.phone,
        address: r.address || '',
        description: r.description || '',
        opening_hours: r.opening_hours || '',
        closing_hours: r.closing_hours || '',
        whatsapp: r.whatsapp || '',
        instagram: r.instagram || '',
        facebook: r.facebook || '',
        website: r.website || '',
        plan: r.plan || 'free',
        plan_status: r.plan_status || 'active',
        plan_started_at: r.plan_started_at || null,
        plan_expires_at: r.plan_expires_at || null,
        created_at: r.created_at,
        ordering_enabled: !!Number(r.ordering_enabled),
        scans: Number(views && views.c) || 0,
        social_clicks: Number(clicks && clicks.c) || 0,
        orders: Number(orders && orders.c) || 0,
        sales: Number(orders && orders.s) || 0,
        items: Number(items && items.c) || 0,
      });
    }
    res.json({ freeqr: out });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/super-admin/free-qr/:id — remove a free QR restaurant.
 */
router.delete('/super-admin/free-qr/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM free_qr_menus WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await run('DELETE FROM free_qr_orders WHERE free_qr_id = ?', [id]);
    await run('DELETE FROM free_qr_items WHERE free_qr_id = ?', [id]);
    await run('DELETE FROM free_qr_events WHERE free_qr_id = ?', [id]);
    await run('DELETE FROM free_qr_menus WHERE id = ?', [id]);
    res.json({ ok: true, deleted: id });
  } catch (err) {
    next(err);
  }
});

const ALLOWED_PLANS = new Set(['free', 'starter', 'business']);
const ALLOWED_PLAN_STATUS = new Set(['active', 'inactive', 'expired', 'cancelled', 'pending']);

function normalizePlanBody(b) {
  const plan = b.plan !== undefined ? String(b.plan).toLowerCase().trim() : undefined;
  const status = b.plan_status !== undefined ? String(b.plan_status).toLowerCase().trim() : undefined;
  if (plan !== undefined && !ALLOWED_PLANS.has(plan)) return { error: 'Invalid plan (free|starter|business)' };
  if (status !== undefined && !ALLOWED_PLAN_STATUS.has(status)) return { error: 'Invalid plan status' };
  const cleanDate = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const s = String(v).trim().slice(0, 32);
    return s || null;
  };
  return {
    plan,
    status,
    plan_started_at: cleanDate(b.plan_started_at),
    plan_expires_at: cleanDate(b.plan_expires_at),
  };
}

router.put('/super-admin/tenants/:id/plan', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tenant = await get('SELECT id FROM tenants WHERE id = ?', [id]);
    if (!tenant) return res.status(404).json({ error: 'Restaurant not found' });
    const p = normalizePlanBody(req.body || {});
    if (p.error) return res.status(400).json({ error: p.error });
    const current = await get('SELECT plan, plan_status, plan_started_at, plan_expires_at FROM tenants WHERE id = ?', [id]);
    await run(
      `UPDATE tenants SET plan = ?, plan_status = ?, plan_started_at = ?, plan_expires_at = ? WHERE id = ?`,
      [
        p.plan !== undefined ? p.plan : (current.plan || 'free'),
        p.status !== undefined ? p.status : (current.plan_status || 'active'),
        p.plan_started_at !== undefined ? p.plan_started_at : current.plan_started_at,
        p.plan_expires_at !== undefined ? p.plan_expires_at : current.plan_expires_at,
        id,
      ]
    );
    res.json({ tenant: await get('SELECT id, name, slug, plan, plan_status, plan_started_at, plan_expires_at, is_active FROM tenants WHERE id = ?', [id]) });
  } catch (err) {
    next(err);
  }
});

router.put('/super-admin/free-qr/:id/plan', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT id FROM free_qr_menus WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const p = normalizePlanBody(req.body || {});
    if (p.error) return res.status(400).json({ error: p.error });
    const current = await get('SELECT plan, plan_status, plan_started_at, plan_expires_at FROM free_qr_menus WHERE id = ?', [id]);
    await run(
      `UPDATE free_qr_menus SET plan = ?, plan_status = ?, plan_started_at = ?, plan_expires_at = ? WHERE id = ?`,
      [
        p.plan !== undefined ? p.plan : (current.plan || 'free'),
        p.status !== undefined ? p.status : (current.plan_status || 'active'),
        p.plan_started_at !== undefined ? p.plan_started_at : current.plan_started_at,
        p.plan_expires_at !== undefined ? p.plan_expires_at : current.plan_expires_at,
        id,
      ]
    );
    res.json({ freeqr: await get('SELECT id, slug, restaurant, plan, plan_status, plan_started_at, plan_expires_at FROM free_qr_menus WHERE id = ?', [id]) });
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

    // Real analytics (tenant menu views/scans) - recorded events only
    let analytics = { views: { total: 0, today: 0, week: 0, month: 0 }, daily: [], monthly: [], recent: [] };
    try {
      const now = new Date();
      const iso = (d) => d.toISOString();
      const todayStr = iso(now).slice(0, 10);
      const weekFrom = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6, 0, 0, 0))).slice(0, 19).replace('T', ' ');
      const monthFrom = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29, 0, 0, 0))).slice(0, 19).replace('T', ' ');
      const todayLike = todayStr + '%';
      const total = await get("SELECT COUNT(*) AS c FROM tenant_menu_events WHERE tenant_id = ? AND kind = 'view'", [tenantId]);
      const today = await get("SELECT COUNT(*) AS c FROM tenant_menu_events WHERE tenant_id = ? AND kind = 'view' AND created_at LIKE ?", [tenantId, todayLike]);
      const week = await get("SELECT COUNT(*) AS c FROM tenant_menu_events WHERE tenant_id = ? AND kind = 'view' AND created_at >= ?", [tenantId, weekFrom]);
      const month = await get("SELECT COUNT(*) AS c FROM tenant_menu_events WHERE tenant_id = ? AND kind = 'view' AND created_at >= ?", [tenantId, monthFrom]);
      const daily = await query(
        `SELECT substr(created_at,1,10) AS day, COUNT(*) AS c FROM tenant_menu_events
          WHERE tenant_id = ? AND kind = 'view' AND created_at >= ?
          GROUP BY substr(created_at,1,10) ORDER BY day ASC`,
        [tenantId, weekFrom]
      );
      const monthly = await query(
        `SELECT substr(created_at,1,10) AS day, COUNT(*) AS c FROM tenant_menu_events
          WHERE tenant_id = ? AND kind = 'view' AND created_at >= ?
          GROUP BY substr(created_at,1,10) ORDER BY day ASC`,
        [tenantId, monthFrom]
      );
      const recent = await query(
        `SELECT e.kind, e.created_at, tb.name AS table_name
           FROM tenant_menu_events e
           LEFT JOIN tables tb ON tb.id = e.table_id
          WHERE e.tenant_id = ?
          ORDER BY e.id DESC LIMIT 20`,
        [tenantId]
      );
      analytics = {
        views: {
          total: Number(total && total.c) || 0,
          today: Number(today && today.c) || 0,
          week: Number(week && week.c) || 0,
          month: Number(month && month.c) || 0,
        },
        daily: daily.map((r) => ({ day: r.day, views: Number(r.c) || 0 })),
        monthly: monthly.map((r) => ({ day: r.day, views: Number(r.c) || 0 })),
        recent: recent.map((r) => ({ kind: r.kind, created_at: r.created_at, table_name: r.table_name || null })),
      };
    } catch (_) { /* keep defaults if events table/query unavailable */ }

    res.json({ tables, menuItems, staff, openOrders: open, allOrders, analytics });
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
 * PUT /api/admin/restaurant  (owner-managed profile/settings; plan is admin-managed)
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
    const clean = (v, max) => v === undefined ? undefined : (v ? String(v).trim().slice(0, max) : null);
    await run(
      `UPDATE tenants SET
         name = ?, phone = ?, address = ?, description = ?, opening_hours = ?, closing_hours = ?,
         logo_url = ?, currency = ?, gst_percent = ?,
         wifi_name = ?, wifi_password = ?, upi_id = ?,
         whatsapp = ?, instagram = ?, facebook = ?, website = ?,
         rush_mode = ?, prep_minutes = ?
       WHERE id = ?`,
      [
        b.name != null ? String(b.name).trim() : t.name,
        b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : t.phone,
        b.address !== undefined ? (b.address ? String(b.address).trim() : null) : t.address,
        b.description !== undefined ? (b.description ? String(b.description).trim().slice(0, 1000) : null) : (t.description || null),
        b.opening_hours !== undefined ? (b.opening_hours ? String(b.opening_hours).trim().slice(0, 120) : null) : (t.opening_hours || null),
        b.closing_hours !== undefined ? (b.closing_hours ? String(b.closing_hours).trim().slice(0, 120) : null) : (t.closing_hours || null),
        b.logo_url !== undefined ? (b.logo_url ? String(b.logo_url).trim() : null) : t.logo_url,
        b.currency != null ? String(b.currency).trim() : t.currency,
        gst,
        b.wifi_name !== undefined ? (b.wifi_name ? String(b.wifi_name).trim() : null) : t.wifi_name,
        b.wifi_password !== undefined ? (b.wifi_password ? String(b.wifi_password).trim() : null) : t.wifi_password,
        b.upi_id !== undefined ? (b.upi_id ? String(b.upi_id).trim() : null) : t.upi_id,
        b.whatsapp !== undefined ? (b.whatsapp ? String(b.whatsapp).trim().slice(0, 200) : null) : (t.whatsapp || null),
        b.instagram !== undefined ? (b.instagram ? String(b.instagram).trim().slice(0, 200) : null) : (t.instagram || null),
        b.facebook !== undefined ? (b.facebook ? String(b.facebook).trim().slice(0, 200) : null) : (t.facebook || null),
        b.website !== undefined ? (b.website ? String(b.website).trim().slice(0, 200) : null) : (t.website || null),
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
