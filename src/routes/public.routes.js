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

async function getSetting(key, fallback = '') {
  const row = await get('SELECT value FROM admin_settings WHERE key = ?', [key]);
  return row && row.value !== null && row.value !== undefined ? row.value : fallback;
}

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

/** Only local paths and absolute http(s) URLs are served as item photos. */
function publicImageUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s.slice(0, 500);
  if (/^https?:\/\//i.test(s)) return s.slice(0, 500);
  return '';
}

/** Public URL for a dish photo (uploaded data URIs get a cacheable URL). */
function itemImageUrl(row, slug) {
  const raw = String(row.image_url || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) {
    return slug ? `/m/${slug}/item-photo/${row.id}` : '';
  }
  return publicImageUrl(raw);
}

/** Dish photo input from the dashboard: data URI, local path or http(s) URL. */
function sanitizeItemImage(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^data:image\/(?:jpeg|jpg|png|webp|hei[cf]);base64,/i.test(s)) {
    return s.length > 2 * 1024 * 1024 ? '' : s;
  }
  return publicImageUrl(s);
}

/** JSON that can safely live inside a <script> tag in the HTML. */
function jsonForHtml(value) {
  return JSON.stringify(value == null ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function publicFreeQr(row) {
  const data = typeof row.menu_data === 'string' ? row.menu_data : '';
  const images = parseMenuImages(data);
  const menuIsFile = images.length > 0 && images[0].startsWith('data:');
  const logoIsFile = typeof row.logo_url === 'string' && row.logo_url.startsWith('data:');
  const menuUrls = images.map((img, i) =>
    img.startsWith('data:') ? `/m/${row.slug}/menu/${i}` : (/^https?:\/\//i.test(img) ? img : null)
  ).filter(Boolean);
  const profile = {
    slug: row.slug,
    url: `/m/${row.slug}`,
    restaurant: row.restaurant,
    owner_name: row.owner_name || '',
    phone: row.phone || '',
    address: row.address || '',
    description: row.description || '',
    opening_hours: row.opening_hours || '',
    closing_hours: row.closing_hours || '',
    logo_url: logoIsFile
      ? `/m/${row.slug}/logo`
      : (/^https?:\/\//i.test(row.logo_url || '') ? row.logo_url : null),
    logo_is_file: logoIsFile,
    menu_url: menuUrls.length ? menuUrls[0] : null,
    menu_urls: menuUrls,
    menu_is_file: menuIsFile,
    menu_type: row.menu_type,
    instagram: row.instagram || '',
    facebook: row.facebook || '',
    whatsapp: row.whatsapp || '',
    website: row.website || '',
    created_at: row.created_at,
    updated_at: row.updated_at || null,
    ordering_enabled: row.ordering_enabled === undefined ? true : !!Number(row.ordering_enabled),
    kitchen_url: `/m/${row.slug}/kitchen`,
    plan: (row.plan || 'free').toLowerCase(),
    plan_status: row.plan_status || 'active',
    plan_started_at: row.plan_started_at || null,
    plan_expires_at: row.plan_expires_at || null,
  };

  const checks = [
    ['name', !!String(profile.restaurant || '').trim()],
    ['phone', !!String(profile.phone || '').trim()],
    ['address', !!String(profile.address || '').trim()],
    ['description', !!String(profile.description || '').trim()],
    ['hours', !!(String(profile.opening_hours || '').trim() || String(profile.closing_hours || '').trim())],
    ['logo', !!String(row.logo_url || '').trim()],
    ['menu', menuUrls.length > 0],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  profile.profile_completion = { done, total: checks.length, percent: Math.round((done / checks.length) * 100), checks: checks.map(([k, ok]) => ({ key: k, ok })) };
  profile.menu_status = menuUrls.length > 0 ? 'active' : 'missing';
  profile.qr_status = 'active'; // permanent slug/QR
  return profile;
}

/** â‚¹299 / â‚¹49.50 */
function money(n) {
  const v = Number(n) || 0;
  return '\u20B9' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
}

/** Orderable items for one hosted menu (accepts the menu row or just its id). */
async function freeQrItems(menu) {
  const id = menu && typeof menu === 'object' ? menu.id : menu;
  const slug = menu && typeof menu === 'object' ? menu.slug : '';
  const rows = await query(
    'SELECT * FROM free_qr_items WHERE free_qr_id = ? ORDER BY sort_order, id',
    [id]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price) || 0,
    half: Number(r.half_price) || 0,
    full: Number(r.full_price) || 0,
    category: r.category || '',
    description: String(r.description || '').trim(),
    image: itemImageUrl(r, slug),
    available: !!Number(r.is_available),
  }));
}

/** Everything the owner dashboard needs in one payload. */
async function freeQrOwnerPayload(row) {
  const items = await freeQrItems(row);
  const restaurant = publicFreeQr(row);
  // An item-wise menu counts as a menu even without a menu-card photo.
  const hasMenu = (restaurant.menu_urls && restaurant.menu_urls.length > 0) || items.length > 0;
  restaurant.menu_status = hasMenu ? 'active' : 'missing';
  const check = restaurant.profile_completion.checks.find((c) => c.key === 'menu');
  if (check) check.ok = hasMenu;
  const done = restaurant.profile_completion.checks.filter((c) => c.ok).length;
  restaurant.profile_completion.done = done;
  restaurant.profile_completion.percent = Math.round((done / restaurant.profile_completion.total) * 100);
  return {
    restaurant,
    stats: await freeQrStats(row.id),
    items,
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
// Tenant menu view/scan analytics (privacy-conscious, basic dedupe).
const tenantViewSeen = new Map();
const TENANT_VIEW_DEDUPE_MS = 30 * 60 * 1000;

async function logTenantMenuEvent(tenantId, tableId, kind, visitor) {
  try {
    if (kind === 'view') {
      const key = `${tenantId}:${tableId || 0}:${visitor || 'anon'}`;
      const now = Date.now();
      const seen = tenantViewSeen.get(key) || 0;
      if (now - seen < TENANT_VIEW_DEDUPE_MS) return;
      tenantViewSeen.set(key, now);
      if (tenantViewSeen.size > 5000) {
        for (const [k, ts] of tenantViewSeen) {
          if (now - ts > TENANT_VIEW_DEDUPE_MS) tenantViewSeen.delete(k);
        }
      }
    }
    await run(
      'INSERT INTO tenant_menu_events (tenant_id, table_id, kind, visitor) VALUES (?, ?, ?, ?)',
      [tenantId, tableId || null, kind, visitor || null]
    );
  } catch (_) {
    // analytics must never break the customer flow
  }
}

async function logFreeQrEvent(id, kind, visitor) {
  try {
    await run('INSERT INTO free_qr_events (free_qr_id, kind, visitor) VALUES (?, ?, ?)', [id, kind, visitor || null]);
  } catch (err) {
    console.warn('[free-qr] event log failed:', err.message);
  }
}

/** Analytics snapshot for the owner's dashboard (real recorded data only). */
async function freeQrStats(id) {
  const now = new Date();
  const iso = (d) => d.toISOString();
  const ymd = (d) => iso(d).slice(0, 10);
  const todayStr = ymd(now);
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6, 0, 0, 0));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29, 0, 0, 0));
  const todayLike = todayStr + '%';
  const weekFrom = iso(weekStart).slice(0, 19).replace('T', ' ');
  const monthFrom = iso(monthStart).slice(0, 19).replace('T', ' ');

  const zero = () => ({ total: 0, today: 0 });
  const stats = {
    views: { total: 0, today: 0, unique: 0, week: 0, month: 0 },
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
    [id, todayLike]
  );
  const uniq = await get(
    'SELECT COUNT(DISTINCT visitor) AS c FROM free_qr_events WHERE free_qr_id = ? AND kind = ?',
    [id, 'view']
  );
  const weekViews = await get(
    "SELECT COUNT(*) AS c FROM free_qr_events WHERE free_qr_id = ? AND kind = 'view' AND created_at >= ?",
    [id, weekFrom]
  );
  const monthViews = await get(
    "SELECT COUNT(*) AS c FROM free_qr_events WHERE free_qr_id = ? AND kind = 'view' AND created_at >= ?",
    [id, monthFrom]
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
  stats.views.week = Number(weekViews && weekViews.c) || 0;
  stats.views.month = Number(monthViews && monthViews.c) || 0;

  const dailyRows = await query(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c
       FROM free_qr_events
      WHERE free_qr_id = ? AND kind = 'view' AND created_at >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day ASC`,
    [id, weekFrom]
  );
  const monthlyRows = await query(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c
       FROM free_qr_events
      WHERE free_qr_id = ? AND kind = 'view' AND created_at >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day ASC`,
    [id, monthFrom]
  );
  stats.daily = dailyRows.map((r) => ({ day: r.day, views: Number(r.c) || 0 }));
  stats.monthly = monthlyRows.map((r) => ({ day: r.day, views: Number(r.c) || 0 }));

  const recent = await query(
    `SELECT kind, created_at
       FROM free_qr_events
      WHERE free_qr_id = ?
      ORDER BY id DESC
      LIMIT 20`,
    [id]
  );
  stats.recent = recent.map((r) => ({ kind: r.kind, created_at: r.created_at }));

  const ord = await get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS s
       FROM free_qr_orders
      WHERE free_qr_id = ? AND status <> 'cancelled' AND created_at LIKE ?`,
    [id, todayLike]
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

    // Real analytics: record a tenant menu view/scan (privacy-conscious, deduped).
    try {
      await logTenantMenuEvent(table.tenant_id, table.table_id, 'view', visitorId(req));
    } catch (_) { /* never break menu load */ }

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
    const rawItems = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
    if (!restaurant || (!menuData && !rawItems.length)) {
      return res.status(400).json({ error: 'Restaurant name aur menu (card ya dishes) zaroori hai' });
    }

    // iPhones upload HEIC photos, which most browsers cannot display. Convert
    // them to JPEG now so the menu always renders.
    const normalMenu = menuData ? await normalizeMenuData(menuData) : { value: '', changed: false };
    menuData = normalMenu.value;

    const cleanItems = [];
    for (const raw of rawItems) {
      const name = String((raw && raw.name) || '').trim().slice(0, 120);
      if (!name) continue;
      const price = Math.max(0, Math.min(1000000, Number(raw.price) || 0));
      const category = String((raw && raw.category) || '').trim().slice(0, 60) || null;
      let image = sanitizeItemImage(raw && (raw.image || raw.image_url));
      const half = raw && (raw.half != null || raw.half_price != null || raw.price_half != null)
        ? Math.max(0, Math.min(1000000, Number(raw.half != null ? raw.half : (raw.half_price != null ? raw.half_price : raw.price_half)) || 0))
        : null;
      const full = raw && (raw.full != null || raw.full_price != null || raw.price_full != null)
        ? Math.max(0, Math.min(1000000, Number(raw.full != null ? raw.full : (raw.full_price != null ? raw.full_price : raw.price_full)) || 0))
        : null;
      const description = raw && raw.description != null ? String(raw.description).trim().slice(0, 2000) || null : null;
      const effectivePrice = (full && full > 0) ? full : (price || (half || 0));
      cleanItems.push({
        name, price: effectivePrice, category, image, half, full, description,
        available: raw && raw.available === false ? 0 : 1,
      });
    }
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
      : (menuData.startsWith('data:application/pdf') ? 'pdf' : (cleanItems.length && !menuData ? 'items' : 'image'));
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
    let sort = 0;
    for (const it of cleanItems) {
      // eslint-disable-next-line no-await-in-loop
      await run(
        'INSERT INTO free_qr_items (free_qr_id, name, price, category, is_available, sort_order, image_url, half_price, full_price, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, it.name, it.price, it.category, it.available, sort++, it.image || null, it.half, it.full, it.description]
      );
    }
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
 * GET /api/public/free-qr/me — owner dashboard data from a free-QR token.
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
 * PATCH /api/public/free-qr/me — owner edits their own hosted page.
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
    if (b.address !== undefined) next_.address = String(b.address || '').trim().slice(0, 300) || null;
    if (b.description !== undefined) next_.description = String(b.description || '').trim().slice(0, 1000) || null;
    if (b.opening_hours !== undefined) next_.opening_hours = String(b.opening_hours || '').trim().slice(0, 120) || null;
    if (b.closing_hours !== undefined) next_.closing_hours = String(b.closing_hours || '').trim().slice(0, 120) || null;

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
             address = ?, description = ?, opening_hours = ?, closing_hours = ?,
             ordering_enabled = ?, updated_at = ?
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
        next_.address || null,
        next_.description || null,
        next_.opening_hours || null,
        next_.closing_hours || null,
        next_.ordering_enabled === undefined ? 1 : (next_.ordering_enabled ? 1 : 0),
        new Date().toISOString().slice(0, 19).replace('T', ' '),
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
 * GET  /api/public/free-qr/items — the owner's orderable menu.
 * PUT  /api/public/free-qr/items — replace it (bulk paste from the dashboard).
 *      body: { ordering_enabled, items: [{ name, price, category, image, available }] }
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
    res.json({ items: await freeQrItems(row), ordering_enabled: !!Number(row.ordering_enabled) });
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
      const hasDescription = !!(raw && Object.prototype.hasOwnProperty.call(raw, 'description'));
      const description = hasDescription ? String(raw.description || '').trim().slice(0, 2000) || null : null;
      const hasImage = !!(raw && (Object.prototype.hasOwnProperty.call(raw, 'image') || Object.prototype.hasOwnProperty.call(raw, 'image_url')));
      const image = hasImage ? sanitizeItemImage(raw.image !== undefined ? raw.image : raw.image_url) : null;
      const hasHalf = !!(raw && (Object.prototype.hasOwnProperty.call(raw, 'half') || Object.prototype.hasOwnProperty.call(raw, 'half_price') || Object.prototype.hasOwnProperty.call(raw, 'price_half')));
      const hasFull = !!(raw && (Object.prototype.hasOwnProperty.call(raw, 'full') || Object.prototype.hasOwnProperty.call(raw, 'full_price') || Object.prototype.hasOwnProperty.call(raw, 'price_full')));
      const half = hasHalf ? Math.max(0, Math.min(1000000, Number(raw.half != null ? raw.half : (raw.half_price != null ? raw.half_price : raw.price_half)) || 0)) : null;
      const full = hasFull ? Math.max(0, Math.min(1000000, Number(raw.full != null ? raw.full : (raw.full_price != null ? raw.full_price : raw.price_full)) || 0)) : null;
      clean.push({
        id: Number(raw && raw.id) || 0,
        name, price, category, image, hasImage, half, full, hasHalf, hasFull, description, hasDescription,
        available: raw && raw.available === false ? 0 : 1,
      });
    }

    const enabled = b.ordering_enabled === undefined
      ? (row.ordering_enabled ? 1 : 0)
      : (b.ordering_enabled ? 1 : 0);

    await transaction(async () => {
      const existing = await query('SELECT id FROM free_qr_items WHERE free_qr_id = ?', [row.id]);
      const existingIds = new Set(existing.map((r) => Number(r.id)));
      const keep = new Set();
      let sort = 0;
      for (const it of clean) {
        // eslint-disable-next-line no-await-in-loop
        // Effective single price for ordering/cart: prefer full price when portions exist.
        const effectivePrice = (it.full && it.full > 0) ? it.full : (it.price || (it.half || 0));
        if (it.id && existingIds.has(it.id)) {
          keep.add(it.id);
          await run(
            'UPDATE free_qr_items SET name = ?, price = ?, category = ?, is_available = ?, sort_order = ? WHERE id = ? AND free_qr_id = ?',
            [it.name, effectivePrice, it.category, it.available, sort, it.id, row.id]
          );
          if (it.hasImage) {
            await run('UPDATE free_qr_items SET image_url = ? WHERE id = ? AND free_qr_id = ?', [it.image || null, it.id, row.id]);
          }
          if (it.hasHalf) {
            await run('UPDATE free_qr_items SET half_price = ? WHERE id = ? AND free_qr_id = ?', [it.half, it.id, row.id]);
          }
          if (it.hasFull) {
            await run('UPDATE free_qr_items SET full_price = ? WHERE id = ? AND free_qr_id = ?', [it.full, it.id, row.id]);
          }
          if (it.hasDescription) {
            await run('UPDATE free_qr_items SET description = ? WHERE id = ? AND free_qr_id = ?', [it.description, it.id, row.id]);
          }
        } else {
          await run(
            'INSERT INTO free_qr_items (free_qr_id, name, price, category, is_available, sort_order, image_url, half_price, full_price, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [row.id, it.name, effectivePrice, it.category, it.available, sort, it.image || null, it.half, it.full, it.description]
          );
        }
        sort += 1;
      }
      for (const id of existingIds) {
        if (!keep.has(id)) await run('DELETE FROM free_qr_items WHERE id = ? AND free_qr_id = ?', [id, row.id]);
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
 * GET   /api/public/free-qr/kitchen/orders — live board for the owner.
 * PATCH /api/public/free-qr/kitchen/orders/:id — advance/cancel an order.
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
 * GET /api/public/m/:slug/order/:token — customer's own order status.
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
 * POST /api/public/m/:slug/order — place an order straight from the QR menu.
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

    const menu = await freeQrItems(row);
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
 * GET /m/:slug — serves the uploaded free menu.
 * Exported as `hostedMenuPage` so server.js can mount it at the site root
 * (`/m/<slug>`), which is what the generated QR code points to.
 */
/** Inline icons for the hosted customer menu — no external requests. */
const MENU_ICONS = {
  phone: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.7-.9L3 21l2-5.1A8.4 8.4 0 1 1 21 11.5Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z"/><circle cx="12" cy="13" r="4"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>'
};

/** Serve one uploaded dish photo (stored as a data URI or URL). */
async function hostedItemPhoto(req, res, next) {
    try {
    const menu = await get('SELECT id FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
    if (!menu) return res.status(404).send('Not found');
    const item = await get('SELECT image_url FROM free_qr_items WHERE id = ? AND free_qr_id = ?', [Number(req.params.id) || 0, menu.id]);
    const value = String((item && item.image_url) || '');
    if (!value) return res.status(404).send('Not found');
    if (!value.startsWith('data:')) {
      if (/^https?:\/\//i.test(value) || (value.startsWith('/') && !value.startsWith('//'))) return res.redirect(302, value);
      return res.status(404).send('Not found');
    }
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value);
    if (!match) return res.status(404).send('Not found');
    let buf;
    try {
      buf = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'binary');
    } catch (_) {
      return res.status(404).send('Not found');
    }
    let contentType = match[1] || 'application/octet-stream';
    if (/^image\/hei[cf]/i.test(contentType)) {
      try { buf = await convertHeicBuffer(buf); contentType = 'image/jpeg'; } catch (_) { /* serve original */ }
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Content-Length', String(buf.length));
    res.send(buf);
  } catch (err) {
    next(err);
  }
}

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
      ? `<img src="${escapeHtml(logoSrc)}${String(logoSrc).startsWith('/') ? '?v=' + Date.now() : ''}" alt="${escapeHtml(row.restaurant)}" />`
      : `<div class="qm-logo-fallback" aria-hidden="true">${escapeHtml((row.restaurant || 'R').charAt(0).toUpperCase())}</div>`;

    const menuData = String(row.menu_data || '');
    const menuImages = parseMenuImages(menuData);
    const isPdf = String(row.menu_type || '').toLowerCase() === 'pdf';
    const pdfHref = isPdf && menuImages[0] && menuImages[0].startsWith('data:')
      ? `/m/${row.slug}/menu/0`
      : '';

    // Uploaded menu-card pages become the photo gallery (tap to zoom).
    const photos = [];
    if (!pdfHref) {
      menuImages.forEach((img, i) => {
        if (img.startsWith('data:')) photos.push(`/m/${row.slug}/menu/${i}`);
        else if (img.startsWith('/')) photos.push(img);
        else if (/^https?:\/\//i.test(img)) photos.push(img);
      });
    }

    // Text menu — only when the owner converted the menu card into items.
    const allItems = await freeQrItems(row);
    const textItems = allItems.filter((i) => i.available);
    const items = textItems.map((it) => ({
      n: it.name,
      p: Number(it.price) || 0,
      half: Number(it.half) || 0,
      full: Number(it.full) || 0,
      c: it.category || '',
      d: String(it.description || '').trim(),
      img: publicImageUrl(it.image),
    }));

    const pageData = {
      restaurant: row.restaurant || '',
      whatsapp: row.whatsapp || '',
      items,
      photos,
      pdf: pdfHref,
      hours: { open: row.opening_hours || '', close: row.closing_hours || '' },
    };

    // ---- social links ----
    const socials = [];
    const socialBtn = (network, label, bg, fg) =>
      `<a class="qm-social" href="/m/${escapeHtml(row.slug)}/go/${network}" target="_blank" rel="noopener" style="background:${bg};color:${fg || '#fff'}">${escapeHtml(label)}</a>`;
    if (row.whatsapp && phoneDigits(row.whatsapp)) socials.push(socialBtn('whatsapp', 'WhatsApp', '#25d366', '#05301c'));
    if (row.instagram) socials.push(socialBtn('instagram', 'Instagram', 'linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)'));
    if (row.facebook) socials.push(socialBtn('facebook', 'Facebook', '#1466c0'));
    if (row.website) socials.push(socialBtn('website', 'Website', '#C24700'));

    // ---- hero pieces ----
    const ownerLine = row.owner_name
      ? `<p class="qm-sub"><span data-i18n="by">By</span> ${escapeHtml(row.owner_name)}</p>`
      : '';
    const hoursText = `${escapeHtml(row.opening_hours || '')}${row.opening_hours && row.closing_hours ? ' – ' : ''}${escapeHtml(row.closing_hours || '')}`;
    const hoursBadge = (row.opening_hours || row.closing_hours)
      ? `<span class="qm-badge">${MENU_ICONS.clock}${hoursText}</span>`
      : '';
    const addressBadge = row.address
      ? `<span class="qm-badge">${MENU_ICONS.pin}${escapeHtml(row.address)}</span>`
      : '';
    const descHtml = row.description ? `<p class="qm-desc">${escapeHtml(row.description)}</p>` : '';
    const callBtn = row.phone
      ? `<a class="qm-btn qm-btn-call" href="tel:${escapeHtml(phoneDigits(row.phone))}">${MENU_ICONS.phone}<span class="qm-btn-2"><b data-i18n="call">Call us</b><span class="qm-num">${escapeHtml(prettyPhone(row.phone))}</span></span></a>`
      : '';
    const waBtn = row.whatsapp && phoneDigits(row.whatsapp)
      ? `<a class="qm-btn qm-btn-wa" href="/m/${escapeHtml(row.slug)}/go/whatsapp" target="_blank" rel="noopener">${MENU_ICONS.chat}<span>WhatsApp</span></a>`
      : '';

    // ---- Ads (free plan only, like before) ----
    let adsHtml = '';
    const rowPlan = String(row.plan || 'free').toLowerCase();
    if (rowPlan === 'free') {
      try {
        const adEnabled = await get('SELECT value FROM admin_settings WHERE key = ?', ['ad_enabled']);
        if (adEnabled && adEnabled.value === '1') {
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const ads = await query(
            `SELECT id, title, image_url, destination_url FROM advertisements
             WHERE placement = 'public_menu' AND is_active = 1
               AND (start_date IS NULL OR start_date <= ?)
               AND (end_date IS NULL OR end_date >= ?)
             ORDER BY created_at DESC LIMIT 2`,
            [now, now]
          );
          if (ads && ads.length) {
            adsHtml = `<div class="qm-ad-label">Advertisement</div>` +
              ads.map((ad) => `<div class="qm-ad" data-ad-id="${ad.id}">
                ${ad.destination_url ? `<a href="${escapeHtml(ad.destination_url)}" target="_blank" rel="noopener" onclick="fetch('/api/public/ads/${ad.id}/click',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitor:'${escapeHtml(visitor)}'})})">` : ''}
                <img src="${escapeHtml(ad.image_url)}" alt="${escapeHtml(ad.title)}" loading="lazy" />
                ${ad.destination_url ? '</a>' : ''}
                <div class="qm-ad-title">${escapeHtml(ad.title)}</div>
              </div>`).join('') +
              `<script>
                (function(){
                  var visitor = '${escapeHtml(visitor)}';
                  document.querySelectorAll('.qm-ad').forEach(function(card){
                    var adId = card.dataset.adId;
                    if (adId) {
                      fetch('/api/public/ads/' + adId + '/impression', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitor:visitor})}).catch(function(){});
                    }
                  });
                })();
              </script>`;
          }
        }
      } catch (e) {
        // Ads are optional, never break the menu.
      }
    }

    // Image-only menus: explain what is inside. PDF-only gets its own hint.
    const noteHtml = items.length
      ? ''
      : (photos.length
        ? `<p class="qm-note">${MENU_ICONS.camera}<span><b data-i18n="photoOnlyTitle">Menu card inside.</b> <span data-i18n="photoOnlyHint">This restaurant uploaded a menu card — tap a photo to zoom.</span></span></p>`
        : (pdfHref
          ? `<p class="qm-note">${MENU_ICONS.pdf}<span><b data-i18n="pdfOnlyTitle">Full menu PDF.</b> <span data-i18n="pdfOnlyHint">Tap the button below to open the menu card as a PDF.</span></span></p>`
          : ''));

    const html = `<!DOCTYPE html>
<html lang="en" data-lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#06183F" />
  <meta name="description" content="${escapeHtml(row.restaurant)} — digital menu${row.address ? ' in ' + escapeHtml(row.address) : ''}. Scan the QR, view the menu on your phone and connect on WhatsApp. Powered by QRush." />
  <link rel="canonical" href="${siteUrl()}/m/${encodeURIComponent(row.slug)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="QRush" />
  <meta property="og:title" content="${escapeHtml(row.restaurant)} — Menu" />
  <meta property="og:description" content="${escapeHtml(row.restaurant)}'s digital menu on QRush. Scan the QR and view it on your phone." />
  <meta property="og:url" content="${siteUrl()}/m/${encodeURIComponent(row.slug)}" />
  <meta property="og:image" content="${siteUrl()}/img/qrush-logo.png" />
  <meta name="twitter:card" content="summary" />
  <title>${escapeHtml(row.restaurant)} — Menu</title>
  <link rel="icon" type="image/png" href="/img/favicon.png?v=3" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/app.css" />
  <link rel="stylesheet" href="/css/menu.css?v=7" />
</head>
<body class="qm-body">
  <a class="qm-skip" href="#qm-main">Skip to menu</a>

  <div class="qm-welcome" id="qm-welcome" hidden aria-live="polite" role="dialog" aria-label="Welcome">
    <div class="qm-welcome-inner">
      <div class="qm-welcome-logo">${logoHtml}</div>
      <p class="qm-welcome-kicker" data-i18n="welcomeKicker">Welcome</p>
      <h2 class="qm-welcome-title" id="qm-welcome-title"></h2>
      <p class="qm-welcome-sub" data-i18n="welcomeSub">Loading your menu…</p>
      <button type="button" class="qm-welcome-skip" id="qm-welcome-skip" data-i18n="welcomeSkip">Tap to enter</button>
    </div>
  </div>

  <div class="qm-shell">
    <header class="qm-hero">
      <div class="qm-hero-bar">
        <p class="qm-kicker" data-i18n="digitalMenu">Digital menu</p>
        <div class="qm-langs" role="group" aria-label="Menu language">
          <button type="button" data-lang="en" aria-pressed="true">EN</button>
          <button type="button" data-lang="hi" aria-pressed="false">हिंदी</button>
          <button type="button" data-lang="mr" aria-pressed="false">मराठी</button>
        </div>
      </div>

      <div class="qm-hero-top">
        <div class="qm-logo">${logoHtml}</div>
        <div>
          <h1 class="qm-title">${escapeHtml(row.restaurant)}</h1>
          ${ownerLine}
        </div>
      </div>

      <div class="qm-badges">
        <span class="qm-badge" id="qm-status" hidden></span>
        ${hoursBadge}
        ${addressBadge}
      </div>

      ${descHtml}

      ${(callBtn || waBtn) ? `<div class="qm-actions">${callBtn}${waBtn}</div>` : ''}
    </header>

    <div class="qm-tools" id="qm-tools"${items.length ? '' : ' hidden'}>
      <div class="qm-search">
        ${MENU_ICONS.search}
        <input id="qm-q" type="search" inputmode="search" autocomplete="off"
               placeholder="Search dishes" aria-label="Search dishes"
               data-i18n-ph="search" data-i18n-aria="search" />
        <button class="qm-clear" id="qm-clear" type="button" hidden
                aria-label="Clear search" data-i18n-aria="clear">&times;</button>
      </div>
      <nav class="qm-chips" id="qm-chips" aria-label="Food categories"></nav>
    </div>

    <main class="qm-main" id="qm-main">
      <div id="qm-list"></div>

      <div class="qm-empty" id="qm-empty" hidden>
        <h3 data-i18n="noResults">No dishes found</h3>
        <p data-i18n="noResultsHint">Try another dish name or pick a different category.</p>
      </div>

      ${noteHtml}

      <section class="qm-section" id="qm-gallery" hidden>
        <h2 class="qm-h2"><span data-i18n="menuCardPhotos">Menu card photos</span></h2>
        <div class="qm-thumbs" id="qm-thumbs"></div>
      </section>

      ${pdfHref ? `<a class="qm-pdf" href="${escapeHtml(pdfHref)}" target="_blank" rel="noopener">${MENU_ICONS.pdf}<span data-i18n="viewPdf">View full menu (PDF)</span></a>` : ''}

      ${socials.length ? `<section class="qm-section"><h2 class="qm-h2"><span data-i18n="connect">Connect with us</span></h2><div class="qm-socials">${socials.join('')}</div></section>` : ''}

      ${adsHtml}
    </main>

    <footer class="qm-foot">
      <a class="qm-foot-brand" href="https://wa.me/919172941524" target="_blank" rel="noopener" aria-label="QRush">
        <img src="/img/qrush-logo.png?v=3" alt="QRush" />
      </a>
      <p class="qm-foot-note">Digital menu by <a href="https://www.qrush.in" target="_blank" rel="noopener">QRush</a></p>
    </footer>
  </div>

  <div class="qm-lightbox" id="qm-lightbox" hidden role="dialog" aria-modal="true" aria-label="Menu card photo">
    <div class="qm-lb-bar">
      <span class="qm-lb-count" id="qm-lb-count"></span>
      <button type="button" class="qm-lb-close" id="qm-lb-close" aria-label="Close photo" data-i18n-aria="close">&times;</button>
    </div>
    <img class="qm-lb-img" id="qm-lb-img" alt="" />
  </div>

  <div class="qm-detail" id="qm-detail" hidden role="dialog" aria-modal="true" aria-label="Dish details">
    <div class="qm-detail-card">
      <button type="button" class="qm-detail-close" id="qm-detail-close" aria-label="Close" data-i18n-aria="close">&times;</button>
      <div class="qm-detail-photo" id="qm-detail-photo"></div>
      <div class="qm-detail-body">
        <h3 class="qm-detail-name" id="qm-detail-name"></h3>
        <p class="qm-detail-cat" id="qm-detail-cat"></p>
        <p class="qm-detail-price" id="qm-detail-price"></p>
        <p class="qm-detail-avail" id="qm-detail-avail"></p>
        <p class="qm-detail-desc" id="qm-detail-desc"></p>
      </div>
    </div>
  </div>

  <script type="application/json" id="qm-data">${jsonForHtml(pageData)}</script>
  <script src="/js/menu.js?v=11" defer></script>
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
router.get('/m/:slug/item-photo/:id', hostedItemPhoto);
router.get('/m/:slug/go/:network', hostedMenuGo);

// tiny html escape helper
function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Public canonical origin used in <link rel="canonical"> and sitemap.xml.
 * Always the apex marketing domain so old hostnames never become duplicates;
 * override with SITE_URL if the domain ever changes.
 */
function siteUrl() {
  return (process.env.SITE_URL || 'https://www.qrush.in').replace(/\/+$/, '');
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> W3C date for sitemaps. */
function sitemapDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * GET /sitemap.xml — every page that deserves a place in Google.
 * Registered at the site root (not under /api/public) in server.js.
 */
async function sitemapXml(req, res, next) {
  try {
    const site = siteUrl();
    const urls = [
      `<url><loc>${site}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
      `<url><loc>${site}/demo-menu.html</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>`,
    ];
    const rows = await query('SELECT slug, updated_at FROM free_qr_menus ORDER BY updated_at DESC');
    for (const row of rows || []) {
      if (!row.slug) continue;
      const lastmod = sitemapDate(row.updated_at);
      urls.push(
        `<url><loc>${site}/m/${encodeURIComponent(row.slug)}</loc>` +
        (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
        `<changefreq>weekly</changefreq><priority>0.8</priority></url>`
      );
    }
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join('\n') + '\n</urlset>\n'
    );
  } catch (err) { next(err); }
}

/** Owners often type "instagram.com/foo" without the protocol. */
function ensureUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

/* ========================= PHASE 3: ADS (PUBLIC) ========================= */

/**
 * GET /api/public/ads — get active ads for a placement.
 * query: placement, tenant_plan (to filter ads for paid plans)
 */
router.get('/ads', async (req, res, next) => {
  try {
    const placement = String(req.query.placement || 'public_menu').trim();
    const tenantPlan = String(req.query.tenant_plan || 'free').toLowerCase().trim();
    // Paid plans are ad-free
    if (tenantPlan === 'starter' || tenantPlan === 'business') {
      return res.json({ ads: [] });
    }
    const adEnabled = await getSetting('ad_enabled', '0');
    if (adEnabled !== '1') return res.json({ ads: [] });

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const rows = await query(
      `SELECT id, title, image_url, destination_url FROM advertisements
       WHERE placement = ? AND is_active = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
       ORDER BY created_at DESC LIMIT 5`,
      [placement, now, now]
    );
    res.json({ ads: rows || [] });
  } catch (err) { next(err); }
});

/**
 * POST /api/public/ads/:id/impression — track ad impression (deduped).
 */
router.post('/ads/:id/impression', async (req, res, next) => {
  try {
    const adId = Number(req.params.id);
    const ad = await get('SELECT id FROM advertisements WHERE id = ? AND is_active = 1', [adId]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    const visitor = String(req.body?.visitor || req.ip || '').slice(0, 64);
    // Dedupe: only count once per visitor per ad per day
    const today = new Date().toISOString().slice(0, 10);
    const existing = await get(
      "SELECT id FROM ad_events WHERE ad_id = ? AND kind = 'impression' AND visitor = ? AND substr(created_at,1,10) = ?",
      [adId, visitor, today]
    );
    if (!existing) {
      await run(
        'INSERT INTO ad_events (ad_id, kind, visitor, created_at) VALUES (?, ?, ?, ?)',
        [adId, 'impression', visitor, new Date().toISOString().replace('T', ' ').slice(0, 19)]
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/public/ads/:id/click — track ad click (deduped).
 */
router.post('/ads/:id/click', async (req, res, next) => {
  try {
    const adId = Number(req.params.id);
    const ad = await get('SELECT id, destination_url FROM advertisements WHERE id = ? AND is_active = 1', [adId]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    const visitor = String(req.body?.visitor || req.ip || '').slice(0, 64);
    const today = new Date().toISOString().slice(0, 10);
    const existing = await get(
      "SELECT id FROM ad_events WHERE ad_id = ? AND kind = 'click' AND visitor = ? AND substr(created_at,1,10) = ?",
      [adId, visitor, today]
    );
    if (!existing) {
      await run(
        'INSERT INTO ad_events (ad_id, kind, visitor, created_at) VALUES (?, ?, ?, ?)',
        [adId, 'click', visitor, new Date().toISOString().replace('T', ' ').slice(0, 19)]
      );
    }
    res.json({ ok: true, destination_url: ad.destination_url });
  } catch (err) { next(err); }
});


/* ========================= PHASE 3: FREE QR BILLING ========================= */

/**
 * GET /api/public/free-qr/billing — get plan info, payments, whatsapp link for free QR owner.
 */
router.get('/free-qr/billing', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT * FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });

    const payments = await query(
      'SELECT * FROM subscription_payments WHERE free_qr_id = ? ORDER BY created_at DESC LIMIT 20',
      [payload.fq]
    );
    const history = await query(
      'SELECT * FROM subscription_history WHERE free_qr_id = ? ORDER BY created_at DESC LIMIT 20',
      [payload.fq]
    );
    const whatsappNumber = await getSetting('whatsapp_number', '');
    const whatsappMessage = await getSetting('whatsapp_support_message', 'Hello QRUSH Team, I want to upgrade my restaurant account.');
    const planPrices = {
      free: await getSetting('plan_free_price', '0'),
      starter: await getSetting('plan_starter_price', '149'),
      business: await getSetting('plan_business_price', '299'),
    };
    const planFeatures = {
      free: await getSetting('plan_free_features', ''),
      starter: await getSetting('plan_starter_features', ''),
      business: await getSetting('plan_business_features', ''),
    };
    const durationDays = Number(await getSetting('default_subscription_duration_days', '30'));

    let remainingDays = null;
    if (row.plan_expires_at) {
      const expiry = new Date(row.plan_expires_at.replace(' ', 'T') + 'Z');
      const now = new Date();
      remainingDays = Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    res.json({
      restaurant: {
        id: row.id,
        restaurant: row.restaurant,
        plan: row.plan || 'free',
        plan_status: row.plan_status || 'active',
        plan_started_at: row.plan_started_at,
        plan_expires_at: row.plan_expires_at,
      },
      payments: payments || [],
      history: history || [],
      whatsapp_number: whatsappNumber,
      whatsapp_message: whatsappMessage,
      plan_prices: planPrices,
      plan_features: planFeatures,
      duration_days: durationDays,
      remaining_days: remainingDays,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/public/free-qr/billing/whatsapp-link — generate WhatsApp upgrade link for free QR owner.
 * query: plan (starter|business)
 */
router.get('/free-qr/billing/whatsapp-link', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const row = await get('SELECT restaurant, phone FROM free_qr_menus WHERE id = ?', [payload.fq]);
    if (!row) return res.status(401).json({ error: 'Restaurant not found' });

    const plan = String(req.query.plan || '').toLowerCase().trim();
    if (!['starter', 'business'].includes(plan)) {
      return res.status(400).json({ error: 'plan must be starter or business' });
    }
    const whatsappNumber = await getSetting('whatsapp_number', '');
    if (!whatsappNumber) {
      return res.json({ whatsapp_number: '', link: null, message: 'WhatsApp number not configured. Please contact support.' });
    }
    const price = await getSetting(plan === 'starter' ? 'plan_starter_price' : 'plan_business_price', plan === 'starter' ? '149' : '299');
    const durationDays = await getSetting('default_subscription_duration_days', '30');
    const baseMessage = await getSetting('whatsapp_support_message', 'Hello QRUSH Team, I want to upgrade my restaurant account.');
    const message = `${baseMessage}

Restaurant Name: ${row.restaurant}
Registered Phone: ${row.phone || 'N/A'}
Selected Plan: ${plan.charAt(0).toUpperCase() + plan.slice(1)}
Plan Price: ₹${price}/month
Duration: ${durationDays} days

Please share payment details.`;
    const encodedMessage = encodeURIComponent(message);
    const cleanNumber = whatsappNumber.replace(/\D/g, '');
    const link = `https://wa.me/${cleanNumber}?text=${encodedMessage}`;
    res.json({ whatsapp_number: whatsappNumber, link, message });
  } catch (err) { next(err); }
});

/**
 * POST /api/public/free-qr/billing/request-upgrade — create pending payment for free QR owner.
 * body: { plan }
 */
router.post('/free-qr/billing/request-upgrade', async (req, res, next) => {
  try {
    const payload = freeQrAuth(req);
    if (!payload) return res.status(401).json({ error: 'Login required' });
    const plan = String((req.body || {}).plan || '').toLowerCase().trim();
    if (!['starter', 'business'].includes(plan)) {
      return res.status(400).json({ error: 'plan must be starter or business' });
    }
    const freeQrId = payload.fq;
    const existing = await get("SELECT id FROM subscription_payments WHERE free_qr_id = ? AND status = 'pending'", [freeQrId]);
    if (existing) {
      return res.status(400).json({ error: 'You already have a pending payment request. Please wait for admin confirmation.' });
    }
    const price = Number(await getSetting(plan === 'starter' ? 'plan_starter_price' : 'plan_business_price', plan === 'starter' ? '149' : '299'));
    const durationDays = Number(await getSetting('default_subscription_duration_days', '30'));
    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const runRes = await run(
      `INSERT INTO subscription_payments (free_qr_id, plan, amount, payment_method, status, payment_type, notes, expires_at, created_at)
       VALUES (?, ?, ?, 'other', 'pending', 'freeqr', 'Upgrade requested via WhatsApp', ?, ?)`,
      [freeQrId, plan, price, expiresAt, new Date().toISOString().replace('T', ' ').slice(0, 19)]
    );
    res.status(201).json({ payment: await get('SELECT * FROM subscription_payments WHERE id = ?', [runRes.lastInsertRowid]) });
  } catch (err) { next(err); }
});

/**
 * GET /api/public/free-qr/ads — get active ads for free QR public menu.
 * query: placement
 */
router.get('/free-qr/ads', async (req, res, next) => {
  try {
    const row = await get('SELECT plan FROM free_qr_menus WHERE slug = ?', [String(req.query.slug || '')]);
    const tenantPlan = row ? (row.plan || 'free') : 'free';
    if (tenantPlan === 'starter' || tenantPlan === 'business') {
      return res.json({ ads: [] });
    }
    const settingRow = await get("SELECT value FROM admin_settings WHERE key = 'ad_enabled'");
    const adEnabled = settingRow ? settingRow.value : '0';
    if (adEnabled !== '1') return res.json({ ads: [] });

    const placement = String(req.query.placement || 'public_menu').trim();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const rows = await query(
      `SELECT id, title, image_url, destination_url FROM advertisements
       WHERE placement = ? AND is_active = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
       ORDER BY created_at DESC LIMIT 3`,
      [placement, now, now]
    );
    res.json({ ads: rows || [] });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.hostedMenuPage = hostedMenuPage;
module.exports.hostedMenuLogo = hostedMenuLogo;
module.exports.hostedMenuMenu = hostedMenuMenu;
module.exports.hostedItemPhoto = hostedItemPhoto;
module.exports.hostedMenuGo = hostedMenuGo;
module.exports.sitemapXml = sitemapXml;
