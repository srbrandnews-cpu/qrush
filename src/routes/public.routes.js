'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, get, run } = require('../config/db');
const { createOrder, getCustomerOrder, decorateForCustomer, cleanPhone } = require('../services/orders');
const { OPEN_STATUSES, REQUEST_TYPES, REQUEST_LABELS } = require('../utils/constants');
const { emitToTenant } = require('../realtime/socket');
const { signFreeQrToken, verifyFreeQrToken } = require('../middleware/auth');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Free QR menu helpers
 * ------------------------------------------------------------------ */

/** Keep digits only so "+91 98765 43210" and "9876543210" match. */
function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Compare two phone numbers on their last 10 digits (ignores country code). */
function samePhone(a, b) {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (!x || !y) return false;
  return x.slice(-10) === y.slice(-10);
}

/** Human-friendly phone for the public menu page. */
function prettyPhone(value) {
  const d = phoneDigits(value);
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (d.length === 10) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  return String(value || '');
}

/** What the owner is allowed to see about their free menu. */
function publicFreeQr(row) {
  const data = typeof row.menu_data === 'string' ? row.menu_data : '';
  const menuIsFile = data.startsWith('data:');
  const logoIsFile = typeof row.logo_url === 'string' && row.logo_url.startsWith('data:');
  return {
    slug: row.slug,
    url: `/m/${row.slug}`,
    restaurant: row.restaurant,
    owner_name: row.owner_name,
    phone: row.phone,
    // Inline data-URIs would make the JSON payload megabytes wide, so serve
    // uploaded files from their own cached URL instead.
    logo_url: logoIsFile
      ? `/m/${row.slug}/logo`
      : (/^https?:\/\//i.test(row.logo_url || '') ? row.logo_url : null),
    menu_url: menuIsFile
      ? `/m/${row.slug}/menu`
      : (/^https?:\/\//i.test(data) ? data : null),
    menu_is_file: menuIsFile,
    menu_type: row.menu_type,
    instagram: row.instagram,
    facebook: row.facebook,
    whatsapp: row.whatsapp,
    website: row.website,
    created_at: row.created_at,
  };
}

/** Social networks we track clicks for. */
const SOCIAL_KINDS = ['whatsapp', 'instagram', 'facebook', 'website'];

/** Real destination for a tracked social button. */
function socialUrl(row, network) {
  if (network === 'whatsapp') {
    const digits = phoneDigits(row.whatsapp);
    return digits ? `https://wa.me/${digits}` : '';
  }
  if (network === 'instagram') return row.instagram ? ensureUrl(row.instagram) : '';
  if (network === 'facebook') return row.facebook ? ensureUrl(row.facebook) : '';
  if (network === 'website') return row.website ? ensureUrl(row.website) : '';
  return '';
}

/** Short non-reversible visitor id so we can count unique people. */
function visitorId(req) {
  const ip = (req.ip || req.connection && req.connection.remoteAddress || 'unknown').toString();
  return crypto.createHash('sha256').update('fq:' + ip).digest('hex').slice(0, 20);
}

// One "view" per visitor per 30 minutes (refreshing the page shouldn't inflate
// the scan count). In-memory only — good enough for a free analytics tile.
const viewSeen = new Map();
const VIEW_WINDOW = 30 * 60 * 1000;

function shouldCountView(id, visitor) {
  const key = `${id}:${visitor}`;
  const now = Date.now();
  const last = viewSeen.get(key);
  if (last && now - last < VIEW_WINDOW) return false;
  viewSeen.set(key, now);
  if (viewSeen.size > 5000) {
    for (const [k, t] of viewSeen) if (now - t > VIEW_WINDOW) viewSeen.delete(k);
  }
  return true;
}

/** Record one analytics event. Never throws — analytics must not break a page. */
async function logFreeQrEvent(id, kind, visitor) {
  try {
    await run('INSERT INTO free_qr_events (free_qr_id, kind, visitor) VALUES (?, ?, ?)', [id, kind, visitor || null]);
  } catch (err) {
    console.warn('[free-qr] event log failed:', err.message);
  }
}

/** Totals + today's numbers for the owner dashboard. */
async function freeQrStats(id) {
  const today = new Date().toISOString().slice(0, 10) + '%';
  const zero = () => ({ total: 0, today: 0 });
  const stats = {
    views: { total: 0, today: 0, unique: 0 },
    clicks: {},
    click_total: { total: 0, today: 0 },
  };
  for (const k of SOCIAL_KINDS) stats.clicks[k] = zero();

  const totals = await query(
    'SELECT kind, COUNT(*) AS c FROM free_qr_events WHERE free_qr_id = ? GROUP BY kind',
    [id]
  );
  const todays = await query(
    'SELECT kind, COUNT(*) AS c FROM free_qr_events WHERE free_qr_id = ? AND created_at LIKE ? GROUP BY kind',
    [id, today]
  );
  const uniq = await get(
    'SELECT COUNT(DISTINCT visitor) AS c FROM free_qr_events WHERE free_qr_id = ? AND kind = ?',
    [id, 'view']
  );

  for (const r of totals) {
    const c = Number(r.c) || 0;
    if (r.kind === 'view') stats.views.total = c;
    else if (stats.clicks[r.kind]) {
      stats.clicks[r.kind].total = c;
      stats.click_total.total += c;
    }
  }
  for (const r of todays) {
    const c = Number(r.c) || 0;
    if (r.kind === 'view') stats.views.today = c;
    else if (stats.clicks[r.kind]) {
      stats.clicks[r.kind].today = c;
      stats.click_total.today += c;
    }
  }
  stats.views.unique = Number(uniq && uniq.c) || 0;
  return stats;
}

// Very light brute-force guard for the free-menu login (no extra dependency).
const freeQrAttempts = new Map();
const FREE_QR_WINDOW = 10 * 60 * 1000;
const FREE_QR_MAX_TRIES = 8;

function freeQrThrottled(key) {
  const now = Date.now();
  const rec = freeQrAttempts.get(key);
  if (!rec || now > rec.reset) {
    freeQrAttempts.set(key, { count: 1, reset: now + FREE_QR_WINDOW });
    return false;
  }
  rec.count += 1;
  return rec.count > FREE_QR_MAX_TRIES;
}

// What the customer still sees on their phone: the kitchen steps plus served
// (so they can pay by UPI and leave a rating before the cashier closes the bill).
const CUSTOMER_ACTIVE = [...OPEN_STATUSES, 'served'];

/**
 * A customer may only see (and rate) orders that belong to their phone or
 * this browser's device id. Without this, the second guest at a table would
 * open the first guest's bill just by scanning the same QR.
 */
function ownsCustomerOrder(row, phone, deviceId) {
  const wanted = cleanPhone(phone);
  if (wanted && cleanPhone(row.customer_phone) === wanted) return true;
  if (deviceId && row.device_id && String(row.device_id) === String(deviceId)) return true;
  return false;
}

/**
 * Resolve a table by its QR token. Anonymous (no login) by design.
 */
async function resolveTable(token) {
  if (!token) return null;
  return get(
    `SELECT t.id AS table_id, t.name AS table_name, t.seats, t.tenant_id,
            tn.name AS restaurant, tn.slug, tn.currency, tn.gst_percent, tn.phone, tn.address, tn.logo_url,
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

    // Only this guest's open orders are returned (phone + device), never the
    // other diners' bills on the same table.
    const phone = req.query.phone || '';
    const deviceId = req.query.deviceId || '';
    const activeRows = (phone || deviceId)
      ? await query(
        `SELECT id, order_no, status, created_at, customer_phone, device_id FROM orders
          WHERE table_id = ? AND status IN (${CUSTOMER_ACTIVE.map(() => '?').join(',')})
          ORDER BY id DESC`,
        [table.table_id, ...CUSTOMER_ACTIVE]
      )
      : [];
    const active = activeRows
      .filter((row) => ownsCustomerOrder(row, phone, deviceId))
      .map(({ id, order_no, status, created_at }) => ({ id, order_no, status, created_at }));

    res.json({
      restaurant: {
        name: table.restaurant,
        slug: table.slug,
        currency: table.currency || '₹',
        gst_percent: table.gst_percent,
        phone: table.phone,
        address: table.address,
        logo_url: table.logo_url,
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
      isParcel: b.isParcel || b.is_parcel || b.orderType === 'takeaway' || b.orderType === 'pickup',
      orderType: b.orderType || b.order_type,
      pickupTime: b.pickupTime || b.pickup_time,
    });

    res.status(201).json({ order: decorateForCustomer(order) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * GET /api/public/orders/:id?table=<qr_token>&phone=...&deviceId=...
 * Live status for the customer, limited to orders that belong to their phone
 * or this browser's device. Orders created before phones/devices were stored
 * stay readable with the table QR alone.
 */
router.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await getCustomerOrder(String(req.query.table || ''), Number(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const identified = order.customer_phone || order.device_id;
    if (identified && !ownsCustomerOrder(order, req.query.phone, req.query.deviceId)) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/public/tables/:token/orders?phone=...&deviceId=...
 * This guest's open orders on the table. Lets a customer reopen the page
 * later and still track their food — without exposing another guest's bill.
 */
router.get('/tables/:token/orders', async (req, res, next) => {
  try {
    const table = await resolveTable(req.params.token);
    if (!table) return res.status(404).json({ error: 'Invalid table' });

    const phone = req.query.phone || '';
    const deviceId = req.query.deviceId || '';
    const rows = (phone || deviceId)
      ? await query(
        `SELECT id, customer_phone, device_id FROM orders
          WHERE table_id = ? AND status IN (${CUSTOMER_ACTIVE.map(() => '?').join(',')}) ORDER BY id`,
        [table.table_id, ...CUSTOMER_ACTIVE]
      )
      : [];

    const orders = [];
    for (const row of rows) {
      if (!ownsCustomerOrder(row, phone, deviceId)) continue;
      const o = await getCustomerOrder(req.params.token, row.id);
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
    if ((order.customer_phone || order.device_id) && !ownsCustomerOrder(order, b.phone, b.deviceId)) {
      return res.status(403).json({ error: 'This order belongs to another guest' });
    }
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

/**
 * POST /api/public/free-qr
 * body: { restaurant, owner_name, phone, password, logo_url, menu_data, menu_type }
 * Creates a free hosted menu page and returns a short URL for the QR code.
 */
router.post('/free-qr', async (req, res, next) => {
  try {
    const b = req.body || {};
    const restaurant = (b.restaurant || '').toString().trim().slice(0, 120);
    const menuData = (b.menu_data || '').toString().trim();
    if (!restaurant || !menuData) {
      return res.status(400).json({ error: 'Restaurant name and menu are required' });
    }
    const slug = crypto.randomBytes(6).toString('hex');
    let passwordHash = null;
    if (b.password) {
      passwordHash = await bcrypt.hash(String(b.password), 10);
    }
    const phone = phoneDigits(b.phone).slice(0, 20) || null;
    const menuType = b.menu_type
      ? String(b.menu_type).slice(0, 20)
      : (menuData.startsWith('data:application/pdf') ? 'pdf' : 'image');
    await run(
      `INSERT INTO free_qr_menus (slug, restaurant, owner_name, phone, password_hash, logo_url, menu_data, menu_type, instagram, facebook, whatsapp, website)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        restaurant,
        (b.owner_name || '').toString().slice(0, 120) || null,
        phone,
        passwordHash,
        b.logo_url || null,
        menuData,
        menuType,
        (b.instagram || '').toString().slice(0, 200) || null,
        (b.facebook || '').toString().slice(0, 200) || null,
        (b.whatsapp || '').toString().slice(0, 200) || null,
        (b.website || '').toString().slice(0, 200) || null,
      ]
    );
    const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [slug]);
    const host = req.get('host');
    const proto = req.protocol;
    const url = `${proto}://${host}/m/${slug}`;
    res.status(201).json({
      slug,
      url,
      token: passwordHash ? signFreeQrToken(row) : null,
      restaurant: publicFreeQr(row),
      stats: await freeQrStats(row.id),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/public/free-qr/login
 * body: { phone, password }
 * Lets a free-menu owner open their own restaurant again.
 */
router.post('/free-qr/login', async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone = phoneDigits(b.phone);
    const password = String(b.password || '');
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone number and password are required' });
    }
    const throttleKey = `${req.ip || 'ip'}:${phone.slice(-10)}`;
    if (freeQrThrottled(throttleKey)) {
      return res.status(429).json({ error: 'Bahut zyada attempts. 10 minute baad try karein.' });
    }

    const rows = await query('SELECT * FROM free_qr_menus ORDER BY id DESC LIMIT 500');
    const matches = rows.filter((r) => r.password_hash && samePhone(r.phone, phone));
    if (!matches.length) {
      return res.status(401).json({ error: 'Is number se koi restaurant nahi mila.' });
    }

    let row = null;
    for (const candidate of matches) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(password, candidate.password_hash)) { row = candidate; break; }
    }
    if (!row) {
      return res.status(401).json({ error: 'Password galat hai.' });
    }

    res.json({
      token: signFreeQrToken(row),
      restaurant: publicFreeQr(row),
      stats: await freeQrStats(row.id),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/public/free-qr/me — owner dashboard data from a free-QR token.
 */
router.get('/free-qr/me', async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyFreeQrToken(token);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });
    res.json({ restaurant: publicFreeQr(row), stats: await freeQrStats(row.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/public/free-qr/me — owner edits their own hosted page.
 * body: { restaurant, owner_name, phone, logo_url, menu_data, menu_type,
 *         instagram, facebook, whatsapp, website, password }
 * Every field is optional; only what's sent gets updated.
 */
router.patch('/free-qr/me', async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyFreeQrToken(token);
    if (!payload) return res.status(401).json({ error: 'Login required' });

    const current = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!current) return res.status(401).json({ error: 'Restaurant not found' });

    const b = req.body || {};
    const next_ = { ...current };

    if (b.restaurant !== undefined) {
      const v = String(b.restaurant || '').trim().slice(0, 120);
      if (!v) return res.status(400).json({ error: 'Restaurant ka naam khali nahi ho sakta.' });
      next_.restaurant = v;
    }
    if (b.owner_name !== undefined) next_.owner_name = String(b.owner_name || '').trim().slice(0, 120) || null;
    if (b.phone !== undefined) next_.phone = phoneDigits(b.phone).slice(0, 20) || null;
    if (b.logo_url !== undefined) next_.logo_url = String(b.logo_url || '').trim() || null;
    if (b.menu_data !== undefined) {
      const v = String(b.menu_data || '').trim();
      if (!v) return res.status(400).json({ error: 'Menu khali nahi ho sakta.' });
      next_.menu_data = v;
      if (b.menu_type === undefined) {
        next_.menu_type = v.startsWith('data:application/pdf') ? 'pdf' : 'image';
      }
    }
    if (b.menu_type !== undefined) next_.menu_type = String(b.menu_type || 'image').slice(0, 20);
    if (b.instagram !== undefined) next_.instagram = String(b.instagram || '').trim().slice(0, 200) || null;
    if (b.facebook !== undefined) next_.facebook = String(b.facebook || '').trim().slice(0, 200) || null;
    if (b.whatsapp !== undefined) next_.whatsapp = String(b.whatsapp || '').trim().slice(0, 200) || null;
    if (b.website !== undefined) next_.website = String(b.website || '').trim().slice(0, 200) || null;

    let passwordHash = current.password_hash;
    if (b.password) {
      const pw = String(b.password);
      if (pw.length < 4) return res.status(400).json({ error: 'Password kam se kam 4 characters ka ho.' });
      passwordHash = await bcrypt.hash(pw, 10);
    }

    // Guard against someone typing a menu URL where an image file is expected.
    if (String(next_.menu_data || '').length > 5 * 1024 * 1024 * 1.4) {
      return res.status(413).json({ error: 'Menu file bahut badi hai (max 5MB).' });
    }

    await run(
      `UPDATE free_qr_menus
         SET restaurant = ?, owner_name = ?, phone = ?, password_hash = ?, logo_url = ?,
             menu_data = ?, menu_type = ?, instagram = ?, facebook = ?, whatsapp = ?, website = ?
       WHERE id = ?`,
      [
        next_.restaurant,
        next_.owner_name,
        next_.phone,
        passwordHash,
        next_.logo_url,
        next_.menu_data,
        next_.menu_type || 'image',
        next_.instagram,
        next_.facebook,
        next_.whatsapp,
        next_.website,
        current.id,
      ]
    );

    const updated = await get('SELECT * FROM free_qr_menus WHERE id = ?', [current.id]);
    res.json({ restaurant: publicFreeQr(updated), stats: await freeQrStats(updated.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /m/:slug/logo and /m/:slug/menu — serve the uploaded files.
 * Stored as data-URIs in the DB, but browsers get a normal, cacheable image
 * URL (and external links simply redirect).
 */
function freeQrAsset(kind) {
  return async function hostedMenuAsset(req, res, next) {
    try {
      const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
      if (!row) return res.status(404).send('Menu not found');
      const value = String((kind === 'logo' ? row.logo_url : row.menu_data) || '');
      if (!value) return res.status(404).send('Not found');

      if (!value.startsWith('data:')) return res.redirect(302, value);

      const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value);
      if (!match) return res.status(404).send('Not found');
      let buf;
      try {
        buf = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'binary');
      } catch (_) {
        return res.status(404).send('Not found');
      }
      res.set('Content-Type', match[1] || 'application/octet-stream');
      res.set('Cache-Control', 'no-cache, must-revalidate');
      res.set('Content-Length', String(buf.length));
      res.send(buf);
    } catch (err) {
      next(err);
    }
  };
}

const hostedMenuLogo = freeQrAsset('logo');
const hostedMenuMenu = freeQrAsset('menu');

/**
 * GET /m/:slug/go/:network — tracked redirect for a social button.
 * Logs the click, then forwards the visitor to the real destination.
 */
async function hostedMenuGo(req, res, next) {
  try {
    const network = String(req.params.network || '').toLowerCase();
    if (!SOCIAL_KINDS.includes(network)) return res.status(404).send('Not found');
    const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
    if (!row) return res.status(404).send('Menu not found');
    const target = socialUrl(row, network);
    if (!target) return res.status(404).send('Not found');
    await logFreeQrEvent(row.id, network, visitorId(req));
    res.redirect(302, target);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /m/:slug — serves the uploaded free menu.
 * Exported as `hostedMenuPage` so server.js can mount it at the site root
 * (`/m/<slug>`), which is what the generated QR code points to.
 */
async function hostedMenuPage(req, res, next) {
  try {
    const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
    if (!row) return res.status(404).send('Menu not found');

    // Count the visit (max once per visitor per 30 min).
    const visitor = visitorId(req);
    if (row.id && shouldCountView(row.id, visitor)) {
      await logFreeQrEvent(row.id, 'view', visitor);
    }

    const logoSrc = row.logo_url
      ? (String(row.logo_url).startsWith('data:')
        ? `/m/${row.slug}/logo`
        : (/^https?:\/\//i.test(row.logo_url) ? row.logo_url : null))
      : null;
    const logoHtml = logoSrc
      ? `<img class="menu-logo" src="${escapeHtml(logoSrc)}" alt="${escapeHtml(row.restaurant)}" />`
      : `<div class="menu-logo menu-logo-fallback">${escapeHtml((row.restaurant || 'R').charAt(0).toUpperCase())}</div>`;

    const menuData = String(row.menu_data || '');
    let menuHtml = '';
    if (menuData.startsWith('data:')) {
      if (String(row.menu_type || '') === 'pdf') {
        menuHtml = `<a class="btn btn-primary btn-lg" href="/m/${escapeHtml(row.slug)}/menu" target="_blank" rel="noopener">📄 View Menu (PDF)</a>`;
      } else {
        menuHtml = `<img src="/m/${escapeHtml(row.slug)}/menu" alt="Menu" style="max-width:100%;border-radius:16px;box-shadow:0 12px 40px -16px rgba(0,0,0,.35)" />`;
      }
    } else if (/^https?:\/\//i.test(menuData)) {
      menuHtml = `<a href="${escapeHtml(menuData)}" target="_blank" rel="noopener" class="btn btn-primary btn-lg">View Menu</a>`;
    }

    const socials = [];
    const socialBtn = (network, label, bg) =>
      `<a class="soc" href="/m/${escapeHtml(row.slug)}/go/${network}" target="_blank" rel="noopener" style="background:${bg}">${label}</a>`;
    if (row.whatsapp && phoneDigits(row.whatsapp)) socials.push(socialBtn('whatsapp', 'WhatsApp', '#25d366'));
    if (row.instagram) socials.push(socialBtn('instagram', 'Instagram', 'linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)'));
    if (row.facebook) socials.push(socialBtn('facebook', 'Facebook', '#1877f2'));
    if (row.website) socials.push(socialBtn('website', 'Website', '#ea580c'));

    const phoneLink = row.phone
      ? `<a class="mcall" href="tel:${escapeHtml(phoneDigits(row.phone))}">📞 ${escapeHtml(prettyPhone(row.phone))}</a>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#ea580c" />
  <title>${escapeHtml(row.restaurant)} — Menu</title>
  <link rel="icon" type="image/png" href="/img/favicon.png?v=3" />
  <link rel="stylesheet" href="/css/app.css" />
  <style>
    body { background: linear-gradient(180deg, #fff7ed 0%, #f6f8fb 340px); margin:0; padding:0; font-family: var(--font); }
    .mwrap { max-width: 620px; margin: 0 auto; padding: 22px 16px 56px; }

    /* 1 — restaurant logo, right at the top */
    .mhead { text-align: center; padding: 8px 0 22px; }
    .mlogo {
      display: inline-flex; align-items: center; justify-content: center;
      background: #fff; border-radius: 26px; padding: 12px;
      box-shadow: 0 22px 48px -26px rgba(15, 23, 42, .5);
    }
    .menu-logo { display: block; max-width: 180px; max-height: 180px; width: auto; height: auto; object-fit: contain; border-radius: 18px; }
    .menu-logo-fallback {
      width: 104px; height: 104px; display: grid; place-items: center;
      font-size: 44px; font-weight: 800; color: #fff; border-radius: 22px;
      background: linear-gradient(135deg, #ea580c, #f97316);
    }
    .mhead h1 { font-size: 27px; line-height: 1.2; margin: 18px 0 4px; color: var(--ink); letter-spacing: -.02em; }
    .mhead .msub { color: var(--muted); font-size: 13.5px; margin: 0; }
    .mcall {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 12px;
      padding: 7px 14px; border-radius: 999px; font-size: 13px; font-weight: 700;
      color: var(--primary-700); background: var(--primary-50);
      border: 1px solid var(--primary-100); text-decoration: none;
    }

    /* 2 — the uploaded menu */
    .menu-card {
      background: #fff; border: 1px solid var(--line); border-radius: 22px;
      padding: 14px; box-shadow: 0 22px 50px -34px rgba(15, 23, 42, .35); text-align: center;
    }
    .sec-title {
      display: flex; align-items: center; gap: 10px;
      font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase;
      color: var(--muted); margin: 0 0 12px;
    }
    .sec-title::after { content: ""; flex: 1; height: 1px; background: var(--line); }
    .menu-card .sec-title { padding: 4px 4px 0; }
    .menu-card img { display: block; margin: 0 auto; }

    /* 3 — social links */
    .socials { margin-top: 26px; }
    .socials .sec-title { padding: 0 4px; }
    .soc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
    .soc {
      display: flex; align-items: center; justify-content: center;
      padding: 13px 16px; border-radius: 14px; color: #fff; font-weight: 700; font-size: 14px;
      text-decoration: none; box-shadow: 0 10px 24px -16px rgba(15, 23, 42, .55);
    }
    .soc:active { transform: scale(.985); }

    .foot { text-align: center; margin-top: 34px; font-size: 11px; color: var(--muted-2); }
  </style>
</head>
<body>
  <div class="mwrap">
    <header class="mhead">
      <div class="mlogo">${logoHtml}</div>
      <h1>${escapeHtml(row.restaurant)}</h1>
      ${row.owner_name ? `<p class="msub">By ${escapeHtml(row.owner_name)}</p>` : ''}
      ${phoneLink}
    </header>

    <section class="menu-card">
      <h2 class="sec-title">Menu</h2>
      ${menuHtml}
    </section>

    ${socials.length ? `<section class="socials"><h2 class="sec-title">Connect with us</h2><div class="soc-grid">${socials.join('')}</div></section>` : ''}

    <div class="foot"><img src="/img/qrush-logo.png?v=3" alt="QRush" style="display:block;width:150px;height:auto;margin:0 auto 10px;background:#fff;padding:6px 10px;border-radius:10px" />Powered by QRush · Free Digital Menu</div>
  </div>
</body>
</html>`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache, must-revalidate');
    res.send(html);
  } catch (err) {
    next(err);
  }
}

router.get('/m/:slug', hostedMenuPage);
router.get('/m/:slug/logo', hostedMenuLogo);
router.get('/m/:slug/menu', hostedMenuMenu);
router.get('/m/:slug/go/:network', hostedMenuGo);

// tiny html escape helper
function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Owners often type "instagram.com/foo" without the protocol. */
function ensureUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

module.exports = router;
module.exports.hostedMenuPage = hostedMenuPage;
module.exports.hostedMenuLogo = hostedMenuLogo;
module.exports.hostedMenuMenu = hostedMenuMenu;
module.exports.hostedMenuGo = hostedMenuGo;
