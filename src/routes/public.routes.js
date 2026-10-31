'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, get, run } = require('../config/db');
const { createOrder, getCustomerOrder, decorateForCustomer, cleanPhone } = require('../services/orders');
const { OPEN_STATUSES, REQUEST_TYPES, REQUEST_LABELS } = require('../utils/constants');
const { emitToTenant } = require('../realtime/socket');

const router = express.Router();

// TEMP: reset passwords
router.get('/__resetpwd', async (req, res) => {
  try {
    const hash = bcrypt.hashSync('pass1234', 10);
    await run('UPDATE users SET password_hash = ?', [hash]);
    const users = await query('SELECT email, role FROM users');
    res.json({ ok: true, count: users.length, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    await run(
      `INSERT INTO free_qr_menus (slug, restaurant, owner_name, phone, password_hash, logo_url, menu_data, menu_type, instagram, facebook, whatsapp, website)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        restaurant,
        (b.owner_name || '').toString().slice(0, 120) || null,
        (b.phone || '').toString().slice(0, 30) || null,
        passwordHash,
        b.logo_url || null,
        menuData,
        (b.menu_type || 'image').toString().slice(0, 20),
        (b.instagram || '').toString().slice(0, 200) || null,
        (b.facebook || '').toString().slice(0, 200) || null,
        (b.whatsapp || '').toString().slice(0, 200) || null,
        (b.website || '').toString().slice(0, 200) || null,
      ]
    );
    const host = req.get('host');
    const proto = req.protocol;
    const url = `${proto}://${host}/m/${slug}`;
    res.status(201).json({ slug, url });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /m/:slug — serves the uploaded free menu.
 */
router.get('/m/:slug', async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM free_qr_menus WHERE slug = ?', [String(req.params.slug)]);
    if (!row) return res.status(404).send('Menu not found');

    const logoHtml = row.logo_url
      ? `<img src="${escapeHtml(row.logo_url)}" alt="${escapeHtml(row.restaurant)}" style="max-width:140px;max-height:140px;border-radius:20px;object-fit:cover;box-shadow:0 12px 30px -12px rgba(0,0,0,.4)" />`
      : `<div style="width:100px;height:100px;border-radius:20px;background:linear-gradient(135deg,#ea580c,#f97316);display:grid;place-items:center;color:#fff;font-size:40px;font-weight:800">${escapeHtml((row.restaurant||'R').charAt(0).toUpperCase())}</div>`;

    const menuData = row.menu_data;
    let menuHtml = '';
    if (typeof menuData === 'string' && menuData.startsWith('data:')) {
      menuHtml = `<img src="${menuData}" alt="Menu" style="max-width:100%;border-radius:16px;box-shadow:0 12px 40px -16px rgba(0,0,0,.35)" />`;
    } else {
      menuHtml = `<a href="${escapeHtml(menuData)}" target="_blank" rel="noopener" class="btn btn-primary btn-lg">View Menu</a>`;
    }

    const socials = [];
    if (row.whatsapp) socials.push(`<a href="https://wa.me/${escapeHtml(String(row.whatsapp).replace(/\\D/g,''))}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:10px;background:#25d366;color:#fff;font-weight:700;text-decoration:none">WhatsApp</a>`);
    if (row.instagram) socials.push(`<a href="${escapeHtml(row.instagram)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:10px;background:linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);color:#fff;font-weight:700;text-decoration:none">Instagram</a>`);
    if (row.facebook) socials.push(`<a href="${escapeHtml(row.facebook)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:10px;background:#1877f2;color:#fff;font-weight:700;text-decoration:none">Facebook</a>`);
    if (row.website) socials.push(`<a href="${escapeHtml(row.website)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:10px;background:#ea580c;color:#fff;font-weight:700;text-decoration:none">Website</a>`);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(row.restaurant)} — Menu</title>
  <link rel="stylesheet" href="/css/app.css" />
  <style>
    body { background: var(--bg); margin:0; padding:0; font-family: var(--font); }
    .mwrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 60px; }
    .mheader { text-align:center; padding: 32px 16px 24px; }
    .mheader h1 { font-size: 28px; margin: 16px 0 4px; color: var(--ink); }
    .mheader p { color: var(--muted); font-size: 14px; margin: 0; }
    .menu-card { background:#fff; border:1px solid var(--line); border-radius:20px; padding:16px; box-shadow: var(--shadow-md); text-align:center; }
    .socials { display:flex; flex-wrap:wrap; gap:10px; justify-content:center; margin-top:24px; }
    .foot { text-align:center; margin-top:32px; font-size:11px; color:var(--muted-2); }
  </style>
</head>
<body>
  <div class="mwrap">
    <div class="mheader">
      ${logoHtml}
      <h1>${escapeHtml(row.restaurant)}</h1>
      ${row.owner_name ? `<p>By ${escapeHtml(row.owner_name)}</p>` : ''}
    </div>
    <div class="menu-card">
      ${menuHtml}
    </div>
    ${socials.length ? `<div class="socials">${socials.join('')}</div>` : ''}
    <div class="foot">Powered by QRush · Free Digital Menu</div>
  </div>
</body>
</html>`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// tiny html escape helper
function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = router;
