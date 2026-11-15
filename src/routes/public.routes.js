'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, get, run, transaction } = require('../config/db');
const { createOrder, getCustomerOrder, decorateForCustomer, cleanPhone } = require('../services/orders');
const { OPEN_STATUSES, REQUEST_TYPES, REQUEST_LABELS } = require('../utils/constants');
const { emitToTenant, emitToFreeQr } = require('../realtime/socket');
const { signFreeQrToken, verifyFreeQrToken } = require('../middleware/auth');
const { normalizeMenuData, normalizeLogo, convertHeicBuffer } = require('../utils/menu-image');

const router = express.Router();

/* ------------------------------------------------------------------ *
 * Free QR menu helpers
 * ------------------------------------------------------------------ */

/** Keep digits only so "+91 91729 41524" and "9172941524" match. */
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
/** Parse menu_data into an array of data-URI strings (supports legacy single). */
function parseMenuImages(data) {
  const s = typeof data === 'string' ? data.trim() : '';
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    } catch (_) { /* fall through */ }
  }
  return [s];
}

function publicFreeQr(row) {
  const data = typeof row.menu_data === 'string' ? row.menu_data : '';
  const images = parseMenuImages(data);
  const menuIsFile = images.length > 0 && images[0].startsWith('data:');
  const logoIsFile = typeof row.logo_url === 'string' && row.logo_url.startsWith('data:');
  const menuUrls = images.map((img, i) =>
    img.startsWith('data:') ? `/m/${row.slug}/menu/${i}` : (/^https?:\/\//i.test(img) ? img : null)
  ).filter(Boolean);
  return {
    slug: row.slug,
    url: `/m/${row.slug}`,
    restaurant: row.restaurant,
    owner_name: row.owner_name,
    phone: row.phone,
    logo_url: logoIsFile
      ? `/m/${row.slug}/logo`
      : (/^https?:\/\//i.test(row.logo_url || '') ? row.logo_url : null),
    menu_url: menuUrls.length ? menuUrls[0] : null,
    menu_urls: menuUrls,
    menu_is_file: menuIsFile,
    menu_type: row.menu_type,
    instagram: row.instagram,
    facebook: row.facebook,
    whatsapp: row.whatsapp,
    website: row.website,
    created_at: row.created_at,
    ordering_enabled: row.ordering_enabled === undefined ? true : !!Number(row.ordering_enabled),
    kitchen_url: `/m/${row.slug}/kitchen`,
  };
}

/** â‚¹299 / â‚¹49.50 */
function money(n) {
  const v = Number(n) || 0;
  return 'â‚¹' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
}

/** Orderable items for one hosted menu. */
async function freeQrItems(id) {
  const rows = await query(
    'SELECT * FROM free_qr_items WHERE free_qr_id = ? ORDER BY sort_order, id',
    [id]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price) || 0,
    category: r.category || '',
    available: !!Number(r.is_available),
  }));
}

/** Everything the owner dashboard needs in one payload. */
async function freeQrOwnerPayload(row) {
  return {
    restaurant: publicFreeQr(row),
    stats: await freeQrStats(row.id),
    items: await freeQrItems(row.id),
  };
}

/** Shape of an order as returned to the kitchen screen / customer. */
function freeQrOrderOut(row) {
  let items = [];
  try { items = JSON.parse(row.items_json || '[]'); } catch (_) { items = []; }
  return {
    id: row.id,
    order_no: Number(row.order_no) || 0,
    token: row.public_token,
    status: row.status,
    table_label: row.table_label,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    note: row.note,
    items,
    total: Number(row.total) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const FREE_QR_ORDER_STATUSES = ['new', 'preparing', 'ready', 'done', 'cancelled'];
const FREE_QR_NEXT_STATUS = { new: 'preparing', preparing: 'ready', ready: 'done' };

// Simple spam guard for public ordering: 12 orders / 10 min per phone+IP.
const orderAttempts = new Map();
const ORDER_WINDOW = 10 * 60 * 1000;
const ORDER_MAX = 12;

function orderThrottled(key) {
  const now = Date.now();
  const rec = orderAttempts.get(key);
  if (!rec || now > rec.reset) {
    orderAttempts.set(key, { count: 1, reset: now + ORDER_WINDOW });
    return false;
  }
  rec.count += 1;
  return rec.count > ORDER_MAX;
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
// the scan count). In-memory only â€” good enough for a free analytics tile.
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

/** Record one analytics event. Never throws â€” analytics must not break a page. */
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

  // Orders that came in through the QR menu today.
  const ord = await get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS s
       FROM free_qr_orders
      WHERE free_qr_id = ? AND status <> 'cancelled' AND created_at LIKE ?`,
    [id, today]
  );
  stats.orders = { today: Number(ord && ord.c) || 0, sales: Number(ord && ord.s) || 0 };

  return stats;
}

// Very light brute-force guard for the free-menu login (no extra dependency).
const freeQrAttempts = new Map();
const FREE_QR_WINDOW = 10 * 60 * 1000;
const FREE_QR_MAX_TRIES = 8;

// In-memory OTP store for first-time phone verification (no SMS provider).
const otpStore = new Map(); // phone(last10) -> { otp, expires, attempts }

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

/** Owner token from `Authorization: Bearer <free-qr token>`. */
function freeQrAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifyFreeQrToken(token);
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
        currency: table.currency || 'â‚¹',
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
 * later and still track their food â€” without exposing another guest's bill.
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
      restaurant: { name: tn.name, slug: tn.slug, phone: tn.phone, address: tn.address, currency: tn.currency || 'â‚¹' },
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
/**
 * POST /api/public/free-qr/send-otp — send OTP for first-time phone verification.
 */
router.post('/free-qr/send-otp', async (req, res, next) => {
  try {
    const phone = phoneDigits((req.body || {}).phone);
    if (!phone || phone.length < 10) return res.status(400).json({ error: 'Valid phone number zaroori hai.' });
    const key = 'otp:' + (req.ip || 'ip') + ':' + phone.slice(-10);
    if (freeQrThrottled(key)) return res.status(429).json({ error: 'Bahut zyada attempts. 10 minute baad try karein.' });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(phone.slice(-10), { otp, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
    res.json({ ok: true, otp, message: 'OTP bhej diya gaya.' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/public/free-qr/verify-otp — verify OTP.
 */
router.post('/free-qr/verify-otp', async (req, res, next) => {
  try {
    const phone = phoneDigits((req.body || {}).phone);
    const otp = String((req.body || {}).otp || '').trim();
    if (!phone || !otp) return res.status(400).json({ error: 'Phone aur OTP zaroori hai.' });
    const rec = otpStore.get(phone.slice(-10));
    if (!rec) return res.status(400).json({ error: 'OTP nahi mila. Pehle Send OTP dabayein.' });
    if (Date.now() > rec.expires) { otpStore.delete(phone.slice(-10)); return res.status(400).json({ error: 'OTP expire ho gaya. Dobara send karein.' }); }
    if (rec.attempts >= 5) { otpStore.delete(phone.slice(-10)); return res.status(429).json({ error: 'Bahut zyada galat attempts. Dobara send karein.' }); }
    if (rec.otp !== otp) { rec.attempts += 1; return res.status(400).json({ error: 'OTP galat hai.' }); }
    rec.verified = true;
    res.json({ ok: true, message: 'Phone verified.' });
  } catch (err) {
    next(err);
  }
});

router.post('/free-qr', async (req, res, next) => {
  try {
    const b = req.body || {};
    const restaurant = (b.restaurant || '').toString().trim().slice(0, 120);
    let menuData = (b.menu_data || '').toString().trim();
    if (!restaurant || !menuData) {
      return res.status(400).json({ error: 'Restaurant name and menu are required' });
    }

    // iPhones upload HEIC photos, which most browsers cannot display. Convert
    // them to JPEG now so the menu always renders.
    const normalMenu = await normalizeMenuData(menuData);
    menuData = normalMenu.value;
    const normalLogo = await normalizeLogo(b.logo_url);
    if (menuData.length > 16 * 1024 * 1024) {
      return res.status(413).json({ error: 'Menu file bahut badi hai (max 16MB).' });
    }
    const slug = crypto.randomBytes(6).toString('hex');
    let passwordHash = null;
    if (b.password) {
      passwordHash = await bcrypt.hash(String(b.password), 10);
    }
    const phone = phoneDigits(b.phone).slice(0, 20) || null;
    // OTP verification (required for first-time creation).
    const otp = String(b.otp || '').trim();
    const otpRec = otpStore.get(phoneDigits(b.phone).slice(-10));
    if (!otpRec || otpRec.otp !== otp || Date.now() > otpRec.expires) {
      return res.status(400).json({ error: 'OTP galat ya expire ho gaya. Dobara send karein.' });
    }
    otpStore.delete(phoneDigits(b.phone).slice(-10));
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
        normalLogo.value || null,
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
      ...(await freeQrOwnerPayload(row)),
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
      ...(await freeQrOwnerPayload(row)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/public/free-qr/me â€” owner dashboard data from a free-QR token.
 */
router.post('/free-qr/reset-password', async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone = String(b.phone || '').trim();
    const password = String(b.password || '');
    if (!phone) return res.status(400).json({ error: 'Phone number zaroori hai.' });
    if (password.length < 4) return res.status(400).json({ error: 'Password kam se kam 4 characters ka ho.' });

    const key = 'reset:' + (req.ip || 'ip') + ':' + phoneDigits(phone);
    if (freeQrThrottled(key)) {
      return res.status(429).json({ error: 'Bahut zyada attempts. 10 minute baad try karein.' });
    }

    const rows = await query('SELECT * FROM free_qr_menus');
    const target = rows.find((r) => samePhone(r.phone, phone));
    if (!target) return res.status(404).json({ error: 'Is phone number se koi account nahi mila.' });

    const hash = await bcrypt.hash(password, 10);
    await run('UPDATE free_qr_menus SET password_hash = ? WHERE id = ?', [hash, target.id]);
    res.json({ ok: true, message: 'Password reset ho gaya. Ab login karein.' });
  } catch (err) {
    next(err);
  }
});

router.get('/free-qr/me', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });
    res.json(await freeQrOwnerPayload(row));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/public/free-qr/me â€” owner edits their own hosted page.
 * body: { restaurant, owner_name, phone, logo_url, menu_data, menu_type,
 *         instagram, facebook, whatsapp, website, password }
 * Every field is optional; only what's sent gets updated.
 */
router.patch('/free-qr/me', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });

    const current = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!current) return res.status(401).json({ error: 'Restaurant not found' });

    const b = req.body || {};
    const next_ = { ...current };
    if (b.ordering_enabled !== undefined) next_.ordering_enabled = b.ordering_enabled ? 1 : 0;

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
      next_.menu_data = v || null;
      if (v && b.menu_type === undefined) {
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

    // iPhone photos arrive as HEIC/HEIF; convert them to JPEG so the uploaded
    // image actually renders on the dashboard and on the customer menu page.
    if (next_.menu_data) {
      const normalMenu = await normalizeMenuData(next_.menu_data);
      next_.menu_data = normalMenu.value || null;
    }
    if (next_.logo_url) {
      const normalLogo = await normalizeLogo(next_.logo_url);
      next_.logo_url = normalLogo.value || null;
    }

    // Guard against someone typing a menu URL where an image file is expected.
    // Images are compressed client-side, so this only catches abuse/legacy data.
    if (String(next_.menu_data || '').length > 16 * 1024 * 1024) {
      return res.status(413).json({ error: 'Menu file bahut badi hai (max 16MB).' });
    }

    await run(
      `UPDATE free_qr_menus
         SET restaurant = ?, owner_name = ?, phone = ?, password_hash = ?, logo_url = ?,
             menu_data = ?, menu_type = ?, instagram = ?, facebook = ?, whatsapp = ?, website = ?,
             ordering_enabled = ?
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
        next_.ordering_enabled === undefined ? 1 : (next_.ordering_enabled ? 1 : 0),
        current.id,
      ]
    );

    const updated = await get('SELECT * FROM free_qr_menus WHERE id = ?', [current.id]);
    res.json(await freeQrOwnerPayload(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * GET  /api/public/free-qr/items â€” the owner's orderable menu.
 * PUT  /api/public/free-qr/items â€” replace it (bulk paste from the dashboard).
 *      body: { ordering_enabled, items: [{ name, price, category, available }] }
 */
router.get('/free-qr/menu-data', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT menu_data FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });
    res.json({ images: parseMenuImages(row.menu_data) });
  } catch (err) {
    next(err);
  }
});

router.get('/free-qr/items', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });
    res.json({ items: await freeQrItems(row.id), ordering_enabled: !!Number(row.ordering_enabled) });
  } catch (err) {
    next(err);
  }
});

router.put('/free-qr/items', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });

    const b = req.body || {};
    const incoming = Array.isArray(b.items) ? b.items : [];
    if (incoming.length > 200) {
      return res.status(400).json({ error: 'Ek baar me max 200 items.' });
    }

    const clean = [];
    for (const raw of incoming) {
      const name = String((raw && raw.name) || '').trim().slice(0, 120);
      if (!name) continue;
      const price = Math.max(0, Math.min(1000000, Number(raw.price) || 0));
      const category = String((raw && raw.category) || '').trim().slice(0, 60) || null;
      clean.push({ name, price, category, available: raw.available === false ? 0 : 1 });
    }

    const enabled = b.ordering_enabled === undefined
      ? (row.ordering_enabled ? 1 : 0)
      : (b.ordering_enabled ? 1 : 0);

    await transaction(async () => {
      await run('DELETE FROM free_qr_items WHERE free_qr_id = ?', [row.id]);
      let sort = 0;
      for (const it of clean) {
        // eslint-disable-next-line no-await-in-loop
        await run(
          'INSERT INTO free_qr_items (free_qr_id, name, price, category, is_available, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
          [row.id, it.name, it.price, it.category, it.available, sort++]
        );
      }
      await run('UPDATE free_qr_menus SET ordering_enabled = ? WHERE id = ?', [enabled, row.id]);
    });

    const updated = await get('SELECT * FROM free_qr_menus WHERE id = ?', [row.id]);
    res.json(await freeQrOwnerPayload(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * GET   /api/public/free-qr/kitchen/orders â€” live board for the owner.
 * PATCH /api/public/free-qr/kitchen/orders/:id â€” advance/cancel an order.
 */
router.get('/free-qr/kitchen/orders', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });

    const active = await query(
      `SELECT * FROM free_qr_orders
        WHERE free_qr_id = ? AND status IN ('new','preparing','ready')
        ORDER BY created_at ASC, id ASC`,
      [row.id]
    );
    const today = new Date().toISOString().slice(0, 10) + '%';
    const summary = await get(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS sales
         FROM free_qr_orders
        WHERE free_qr_id = ? AND status <> 'cancelled' AND created_at LIKE ?`,
      [row.id, today]
    );

    res.json({
      restaurant: { name: row.restaurant, slug: row.slug, phone: row.phone },
      orders: active.map(freeQrOrderOut),
      summary: {
        orders: Number(summary && summary.orders) || 0,
        sales: Number(summary && summary.sales) || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/free-qr/kitchen/orders/:id', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const order = await get(
      'SELECT * FROM free_qr_orders WHERE id = ? AND free_qr_id = ?',
      [Number(req.params.id) || 0, payload.fq]
    );
    if (!order) return res.status(404).json({ error: 'Order nahi mila' });

    const wanted = String((req.body || {}).status || '').toLowerCase();
    // Cancel is allowed from any open state; every other move must be the
    // single legal next step (new â†’ preparing â†’ ready â†’ done).
    const allowed = wanted === 'cancelled'
      ? ['new', 'preparing', 'ready'].includes(order.status)
      : wanted === FREE_QR_NEXT_STATUS[order.status];
    if (!allowed) {
      return res.status(400).json({ error: 'Yeh status change allowed nahi hai.' });
    }

    await run(
      'UPDATE free_qr_orders SET status = ?, updated_at = ? WHERE id = ?',
      [wanted, new Date().toISOString().slice(0, 19).replace('T', ' '), order.id]
    );
    const updated = await get('SELECT * FROM free_qr_orders WHERE id = ?', [order.id]);
    const out = freeQrOrderOut(updated);
    emitToFreeQr(payload.fq, 'freeqr:order', { order: out, reason: 'status' });
    res.json({ order: out });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/public/m/:slug/order/:token â€” customer's own order status.
 */
router.get('/m/:slug/order/:token', async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
    if (!row) return res.status(404).json({ error: 'Menu not found' });
    const order = await get(
      'SELECT * FROM free_qr_orders WHERE free_qr_id = ? AND public_token = ?',
      [row.id, String(req.params.token)]
    );
    if (!order) return res.status(404).json({ error: 'Order nahi mila' });
    res.json({
      order: freeQrOrderOut(order),
      restaurant: { name: row.restaurant, phone: row.phone },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/public/m/:slug/order â€” place an order straight from the QR menu.
 * body: { table, name, phone, note, items: [{ id, qty }] }
 */
router.post('/m/:slug/order', async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
    if (!row) return res.status(404).json({ error: 'Menu not found' });
    if (!Number(row.ordering_enabled)) {
      return res.status(403).json({ error: 'Is restaurant ne abhi online order band rakha hai.' });
    }

    const b = req.body || {};
    const table = String(b.table || '').trim().slice(0, 30);
    if (!table) return res.status(400).json({ error: 'Table number likhna zaroori hai.' });

    const wanted = Array.isArray(b.items) ? b.items : [];
    if (!wanted.length) return res.status(400).json({ error: 'Koi item select karein.' });
    if (wanted.length > 60) return res.status(400).json({ error: 'Bahut zyada items.' });

    const menu = await freeQrItems(row.id);
    const byId = new Map(menu.map((i) => [Number(i.id), i]));

    const lines = [];
    let total = 0;
    let qtySum = 0;
    for (const raw of wanted) {
      const item = byId.get(Number(raw && raw.id));
      const qty = Math.max(0, Math.min(50, Math.floor(Number(raw && raw.qty) || 0)));
      if (!item || !qty) continue;
      if (!item.available) return res.status(400).json({ error: `${item.name} abhi available nahi hai.` });
      const lineTotal = Math.round((item.price * qty + Number.EPSILON) * 100) / 100;
      lines.push({ id: item.id, name: item.name, price: item.price, qty, line_total: lineTotal });
      total += lineTotal;
      qtySum += qty;
    }
    if (!lines.length) return res.status(400).json({ error: 'Koi valid item select karein.' });
    if (qtySum > 200) return res.status(400).json({ error: 'Ek order me max 200 quantity.' });

    const throttleKey = `${req.ip || 'ip'}:${row.id}`;
    if (orderThrottled(throttleKey)) {
      return res.status(429).json({ error: 'Bahut zyada orders. Thodi der baad try karein.' });
    }

    const today = new Date().toISOString().slice(0, 10) + '%';
    const countRow = await get(
      'SELECT COUNT(*) AS c FROM free_qr_orders WHERE free_qr_id = ? AND created_at LIKE ?',
      [row.id, today]
    );
    const orderNo = (Number(countRow && countRow.c) || 0) + 1;
    const token = crypto.randomBytes(12).toString('hex');
    total = Math.round((total + Number.EPSILON) * 100) / 100;

    await run(
      `INSERT INTO free_qr_orders
         (free_qr_id, order_no, public_token, table_label, customer_name, customer_phone, note, items_json, total, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [
        row.id,
        orderNo,
        token,
        table,
        String(b.name || '').trim().slice(0, 80) || null,
        phoneDigits(b.phone).slice(0, 20) || null,
        String(b.note || '').trim().slice(0, 300) || null,
        JSON.stringify(lines),
        total,
      ]
    );

    const saved = await get('SELECT * FROM free_qr_orders WHERE public_token = ?', [token]);
    const out = freeQrOrderOut(saved);

    // Straight to the kitchen screen (and this is what makes the tablet beep).
    emitToFreeQr(row.id, 'freeqr:order', { order: out, reason: 'new' });
    await logFreeQrEvent(row.id, 'order', visitorId(req));

    res.status(201).json({ order: out, restaurant: { name: row.restaurant, phone: row.phone } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /m/:slug/logo and /m/:slug/menu â€” serve the uploaded files.
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
      // Safety net for menus saved before HEIC conversion existed.
      let contentType = match[1] || 'application/octet-stream';
      if (/^image\/hei[cf]/i.test(contentType)) {
        try {
          buf = await convertHeicBuffer(buf);
          contentType = 'image/jpeg';
        } catch (_) { /* serve the original below */ }
      }
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'no-cache, must-revalidate');
      res.set('Content-Length', String(buf.length));
      res.send(buf);
    } catch (err) {
      next(err);
    }
  };
}

const hostedMenuLogo = freeQrAsset('logo');

async function hostedMenuMenu(req, res, next) {
  try {
    const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
    const images = parseMenuImages(row.menu_data);
    const idx = Math.max(0, Math.min(images.length - 1, Number(req.params.idx) || 0));
    const value = String(images[idx] || '');
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
    // Safety net for menus saved before HEIC conversion existed.
    let contentType = match[1] || 'application/octet-stream';
    if (/^image\/hei[cf]/i.test(contentType)) {
      try {
        buf = await convertHeicBuffer(buf);
        contentType = 'image/jpeg';
      } catch (_) { /* serve the original below */ }
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache, must-revalidate');
    res.set('Content-Length', String(buf.length));
    res.send(buf);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /m/:slug/go/:network â€” tracked redirect for a social button.
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
 * Client-side cart for the hosted menu page. Kept as a plain string with no
 * template placeholders so it can be inlined into the server-rendered HTML.
 */
function orderingScript() {
  return `
(function () {
  var section = document.getElementById('order-section');
  if (!section) return;
  var slug = (location.pathname.split('/')[2] || '');
  var base = '/api/public/m/' + slug;
  var cart = {};
  var modal = document.getElementById('order-modal');
  var cartbar = document.getElementById('cartbar');
  var pollTimer = null;

  function rupees(n) {
    var v = Number(n) || 0;
    return '\u20B9' + (v % 1 === 0 ? v : v.toFixed(2));
  }

  function rows() { return section.querySelectorAll('.oi'); }

  function cartItems() {
    var all = rows();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var id = all[i].getAttribute('data-id');
      var qty = cart[id] || 0;
      if (qty > 0) {
        out.push({
          id: Number(id),
          qty: qty,
          name: all[i].querySelector('.oi-name').textContent,
          price: Number(all[i].getAttribute('data-price')) || 0
        });
      }
    }
    return out;
  }

  function renderCart() {
    var all = rows();
    var count = 0;
    var total = 0;
    for (var i = 0; i < all.length; i++) {
      var id = all[i].getAttribute('data-id');
      var q = cart[id] || 0;
      all[i].querySelector('.oi-qty').textContent = q;
      count += q;
      total += q * (Number(all[i].getAttribute('data-price')) || 0);
    }
    document.getElementById('cart-qty').textContent = count;
    document.getElementById('cart-total').textContent = rupees(total);
    if (count > 0) {
      cartbar.classList.remove('hidden');
      document.body.classList.add('has-cart');
    } else {
      cartbar.classList.add('hidden');
      document.body.classList.remove('has-cart');
    }
  }

  section.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var row = btn.closest('.oi');
    if (!row) return;
    var id = row.getAttribute('data-id');
    var q = cart[id] || 0;
    if (btn.getAttribute('data-act') === 'plus') q += 1;
    else q = Math.max(0, q - 1);
    cart[id] = q;
    renderCart();
  });

  function openModal() {
    var list = cartItems();
    if (!list.length) return;
    var box = document.getElementById('cart-summary');
    box.innerHTML = '';
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var line = document.createElement('div');
      line.className = 'cs-line';
      var left = document.createElement('span');
      left.textContent = list[i].qty + ' x ' + list[i].name;
      var right = document.createElement('span');
      var lt = list[i].qty * list[i].price;
      total += lt;
      right.textContent = rupees(lt);
      line.appendChild(left);
      line.appendChild(right);
      box.appendChild(line);
    }
    var tr = document.createElement('div');
    tr.className = 'cs-total';
    var tl = document.createElement('span');
    tl.textContent = 'Total';
    var tv = document.createElement('span');
    tv.textContent = rupees(total);
    tr.appendChild(tl);
    tr.appendChild(tv);
    box.appendChild(tr);

    document.getElementById('order-error').textContent = '';
    modal.classList.remove('hidden');
    setTimeout(function () { document.getElementById('o-table').focus(); }, 80);
  }

  function closeModal() { modal.classList.add('hidden'); }

  document.getElementById('cart-open').addEventListener('click', openModal);
  document.getElementById('sheet-close').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

  document.getElementById('o-submit').addEventListener('click', async function () {
    var btn = this;
    var err = document.getElementById('order-error');
    var table = document.getElementById('o-table').value.trim();
    if (!table) { err.textContent = 'Table number likhein.'; return; }
    var list = cartItems();
    if (!list.length) { err.textContent = 'Koi item select karein.'; return; }

    btn.disabled = true;
    btn.textContent = 'Order bhej rahe hain...';
    err.textContent = '';
    try {
      var payload = {
        table: table,
        name: document.getElementById('o-name').value.trim(),
        phone: document.getElementById('o-phone').value.trim(),
        note: document.getElementById('o-note').value.trim(),
        items: []
      };
      for (var i = 0; i < list.length; i++) payload.items.push({ id: list[i].id, qty: list[i].qty });

      var res = await fetch(base + '/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Order nahi gaya');
      closeModal();
      showSuccess(data.order);
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place order \u2192';
    }
  });

  var STATUS_TEXT = {
    new: 'Kitchen ne order receive kar liya \uD83C\uDF73',
    preparing: 'Aapka order ban raha hai \uD83D\uDC68\u200D\uD83C\uDF73',
    ready: 'Ready! Table par serve ho raha hai \u2705',
    done: 'Order complete \u2014 dhanyavaad! \uD83C\uDF89',
    cancelled: 'Order cancel ho gaya'
  };

  function applyStatus(status) {
    var el = document.getElementById('os-status');
    if (el) el.textContent = STATUS_TEXT[status] || status;
    if (status === 'done' || status === 'cancelled') {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
  }

  function startPolling(token) {
    if (pollTimer) clearInterval(pollTimer);
    var tick = function () {
      fetch(base + '/order/' + token, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && d.order) applyStatus(d.order.status); })
        .catch(function () {});
    };
    tick();
    pollTimer = setInterval(tick, 5000);
  }

  function showSuccess(order) {
    document.getElementById('order-success').classList.remove('hidden');
    document.getElementById('os-no').textContent = 'Order #' + order.order_no;
    applyStatus(order.status);

    var box = document.getElementById('os-items');
    box.innerHTML = '';
    for (var i = 0; i < order.items.length; i++) {
      var line = document.createElement('div');
      line.className = 'cs-line';
      var l = document.createElement('span');
      l.textContent = order.items[i].qty + ' x ' + order.items[i].name;
      var r = document.createElement('span');
      r.textContent = rupees(order.items[i].line_total);
      line.appendChild(l);
      line.appendChild(r);
      box.appendChild(line);
    }
    var tr = document.createElement('div');
    tr.className = 'cs-total';
    var tl = document.createElement('span');
    tl.textContent = 'Total';
    var tv = document.createElement('span');
    tv.textContent = rupees(order.total);
    tr.appendChild(tl);
    tr.appendChild(tv);
    box.appendChild(tr);

    cartbar.classList.add('hidden');
    document.body.classList.remove('has-cart');
    cart = {};
    startPolling(order.token);
    document.getElementById('order-success').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  document.getElementById('os-again').addEventListener('click', function () { location.reload(); });

  renderCart();
})();
`;
}

/**
 * GET /m/:slug â€” serves the uploaded free menu.
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
      ? `<img class="menu-logo" src="${escapeHtml(logoSrc)}${String(logoSrc).startsWith('/') ? '?v=' + Date.now() : ''}" alt="${escapeHtml(row.restaurant)}" />`
      : `<div class="menu-logo menu-logo-fallback">${escapeHtml((row.restaurant || 'R').charAt(0).toUpperCase())}</div>`;

    const menuData = String(row.menu_data || '');
    const menuImages = parseMenuImages(menuData);
    let menuHtml = '';
    const imgCacheBust = Date.now();
    if (menuImages.length) {
      const imgs = menuImages.map((img, i) => {
        if (img.startsWith('data:')) {
          if (String(row.menu_type || '') === 'pdf' && i === 0) {
            return `<a class="btn btn-primary btn-lg" href="/m/${escapeHtml(row.slug)}/menu/${i}" target="_blank" rel="noopener">View Menu (PDF)</a>`;
          }
          return `<img src="/m/${escapeHtml(row.slug)}/menu/${i}?v=${imgCacheBust}" alt="Menu page ${i + 1}" style="max-width:100%;border-radius:16px;box-shadow:0 12px 40px -16px rgba(0,0,0,.35);margin-bottom:12px;display:block" />`;
        }
        if (img.startsWith('/')) {
          return `<img src="${escapeHtml(img)}?v=${imgCacheBust}" alt="Menu page ${i + 1}" style="max-width:100%;border-radius:16px;box-shadow:0 12px 40px -16px rgba(0,0,0,.35);margin-bottom:12px;display:block" />`;
        }
        if (/^https?:\/\//i.test(img)) {
          return `<a href="${escapeHtml(img)}" target="_blank" rel="noopener" class="btn btn-primary btn-lg">View Menu</a>`;
        }
        return '';
      }).join('');
      menuHtml = imgs;
    }

    const socials = [];
    const socialBtn = (network, label, bg) =>
      `<a class="soc" href="/m/${escapeHtml(row.slug)}/go/${network}" target="_blank" rel="noopener" style="background:${bg}">${label}</a>`;
    if (row.whatsapp && phoneDigits(row.whatsapp)) socials.push(socialBtn('whatsapp', 'WhatsApp', '#25d366'));
    if (row.instagram) socials.push(socialBtn('instagram', 'Instagram', 'linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)'));
    if (row.facebook) socials.push(socialBtn('facebook', 'Facebook', '#1877f2'));
    if (row.website) socials.push(socialBtn('website', 'Website', '#ea580c'));

    const phoneLink = row.phone
      ? `<a class="mcall" href="tel:${escapeHtml(phoneDigits(row.phone))}">ðŸ“ž ${escapeHtml(prettyPhone(row.phone))}</a>`
      : '';

    // ---- Menu: the owner's text menu (converted from the menu card) ----
    const allItems = await freeQrItems(row.id);
    const textItems = allItems.filter((i) => i.available);

    let menuSectionHtml = '';

    // 1) Uploaded menu card is ALWAYS shown first (image/PDF).
    if (menuImages.length) {
      menuSectionHtml += `<section class="menu-card">
        <h2 class="sec-title">Menu card</h2>
        ${menuHtml}
      </section>`;
    }

        // 2) Optional text menu — only if the owner converted the card.
    if (textItems.length) {
      const groups = new Map();
      for (const it of textItems) {
        const key = it.category || 'Menu';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      let groupsHtml = '';
      for (const [cat, list] of groups) {
        let rowsHtml = '';
        for (const it of list) {
          rowsHtml += '<div class="oi"><div class="oi-body"><span class="oi-name">' + escapeHtml(it.name) + '</span><span class="oi-dots"></span></div><span class="oi-price">' + money(it.price) + '</span></div>';
        }
        groupsHtml += '<div class="ogroup"><div class="ogroup-title">' + escapeHtml(cat) + '</div>' + rowsHtml + '</div>';
      }
      menuSectionHtml += '<section class="menu-card"><h2 class="sec-title">Menu</h2>' + groupsHtml + '</section>';
    } else if (menuImages.length === 0) {
      menuSectionHtml += '<section class="menu-card"><h2 class="sec-title">Menu</h2><p class="muted tiny">Koi menu upload nahi hua.</p></section>';
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#ea580c" />
  <title>${escapeHtml(row.restaurant)} â€” Menu</title>
  <link rel="icon" type="image/png" href="/img/favicon.png?v=3" />
  <link rel="stylesheet" href="/css/app.css" />
  <style>
    body { background: linear-gradient(180deg, #fff7ed 0%, #f6f8fb 340px); margin:0; padding:0; font-family: var(--font); }
    .mwrap { max-width: 620px; margin: 0 auto; padding: 22px 16px 56px; }

    /* 1 â€” restaurant logo, right at the top */
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

    /* 2 â€” the uploaded menu */
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

    /* 3 â€” social links */
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

    /* 2b â€” ordering */
    body.has-cart .mwrap { padding-bottom: 120px; }
    .order-card {
      margin-top: 20px; background: #fff; border: 1px solid var(--line); border-radius: 22px;
      padding: 16px; box-shadow: 0 22px 50px -34px rgba(15, 23, 42, .35);
    }
    .order-hint { margin: -4px 4px 12px; font-size: 12.5px; color: var(--muted); }
    .ogroup + .ogroup { margin-top: 14px; }
    .ogroup-title {
      font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
      color: var(--muted-2); margin: 4px 4px 6px;
    }
    .oi { display: flex; align-items: center; gap: 10px; padding: 11px 4px; border-top: 1px dashed var(--line); }
    .ogroup .oi:first-of-type { border-top: 0; }
    .oi-body { display: flex; align-items: baseline; gap: 8px; flex: 1; min-width: 0; }
    .oi-name { font-size: 14.5px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .oi-dots { flex: 1; min-width: 12px; border-bottom: 1px dotted #cbd5e1; transform: translateY(-4px); }
    .oi-price { font-size: 14px; font-weight: 800; color: var(--ink-2); font-variant-numeric: tabular-nums; }
    .menucard-wrap { text-align: center; margin-top: 16px; }
    .menucard-link {
      display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
      font-size: 12.5px; font-weight: 700; color: var(--muted);
      background: #f8fafc; border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px;
    }
    .menucard-link:hover { color: var(--ink); background: #f1f5f9; }
    .oi-step {
      display: flex; align-items: center; gap: 6px; background: var(--primary-50);
      border: 1px solid var(--primary-100); border-radius: 11px; padding: 3px;
    }
    .oi-btn {
      width: 30px; height: 30px; border: 0; background: #fff; color: var(--primary-700);
      border-radius: 8px; font-size: 17px; font-weight: 800; cursor: pointer; line-height: 1;
      box-shadow: var(--shadow-xs);
    }
    .oi-btn:active { transform: scale(.94); }
    .oi-qty { min-width: 20px; text-align: center; font-weight: 800; font-size: 14px; color: var(--primary-700); }

    .cartbar {
      position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
      width: min(560px, calc(100% - 24px)); z-index: 60;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: #0f172a; color: #fff; border-radius: 16px; padding: 9px 10px 9px 18px;
      box-shadow: 0 20px 50px -18px rgba(15, 23, 42, .75);
    }
    .cartbar-info { font-size: 13.5px; }
    .cartbar-info b { font-size: 16px; }

    .sheet-wrap {
      position: fixed; inset: 0; z-index: 90; background: rgba(15, 23, 42, .5);
      backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center;
    }
    .sheet {
      width: 100%; max-width: 520px; background: #fff; border-radius: 22px 22px 0 0;
      padding: 18px 18px calc(18px + env(safe-area-inset-bottom));
      max-height: 92vh; overflow: auto;
    }
    @media (min-width: 640px) { .sheet-wrap { align-items: center; } .sheet { border-radius: 22px; } }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .sheet-head h3 { margin: 0; font-size: 17px; }
    .icon-x { border: 0; background: transparent; font-size: 18px; color: var(--muted); cursor: pointer; padding: 4px 8px; border-radius: 8px; }
    .icon-x:hover { background: #f1f5f9; color: var(--ink); }
    .sheet .field { margin-bottom: 12px; }
    .sheet .input { width: 100%; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px; margin-top: 5px; font: inherit; }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .cart-summary { border-top: 1px dashed var(--line); margin-top: 4px; padding-top: 12px; margin-bottom: 10px; }
    .cs-line { display: flex; justify-content: space-between; gap: 10px; font-size: 13.5px; padding: 3px 0; color: var(--ink-2); }
    .cs-total { display: flex; justify-content: space-between; font-weight: 800; font-size: 15px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
    .order-error { color: var(--red); font-size: 12.5px; min-height: 16px; margin: 0 0 8px; }

    .order-success { text-align: center; padding: 6px 4px 4px; }
    .os-icon { font-size: 34px; }
    .order-success h3 { margin: 4px 0 2px; font-size: 19px; }
    .os-no { font-size: 26px; font-weight: 800; color: var(--primary-700); margin: 2px 0 6px; }
    .os-status { font-size: 13.5px; color: var(--muted); margin: 0 0 14px; }
    .os-items { text-align: left; border-top: 1px dashed var(--line); padding-top: 10px; margin-bottom: 14px; }
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

    ${menuSectionHtml}

    ${socials.length ? `<section class="socials"><h2 class="sec-title">Connect with us</h2><div class="soc-grid">${socials.join('')}</div></section>` : ''}

    <div class="foot"><img src="/img/qrush-logo.png?v=3" alt="QRush" style="display:block;width:150px;height:auto;margin:0 auto 10px;background:#fff;padding:6px 10px;border-radius:10px" />Powered by QRush Â· Free Digital Menu</div>
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
router.get('/m/:slug/menu/:idx', hostedMenuMenu);
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
