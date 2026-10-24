'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run, transaction } = require('../config/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes here require super-admin
router.use(requireAuth, requireSuperAdmin);

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

/**
 * GET /api/admin/tenants
 * List all tenants with owner info.
 */
router.get('/', async (req, res, next) => {
  try {
    const tenants = await get(`
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

/**
 * POST /api/admin/tenants
 * Create a new tenant (restaurant) with an owner account.
 * Body: { restaurant, name, email, password, phone }
 */
router.post('/', async (req, res, next) => {
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

/**
 * PATCH /api/admin/tenants/:id
 * Update tenant details (name, phone, is_active).
 */
router.patch('/:id', async (req, res, next) => {
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

/**
 * DELETE /api/admin/tenants/:id
 * Delete a tenant (cascades to users, tables, orders, etc. via FK).
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [id]);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Safety: prevent deleting the demo tenant (id=1) by mistake
    if (Number(id) === 1) {
      return res.status(400).json({ error: 'Demo tenant cannot be deleted' });
    }

    await run('DELETE FROM tenants WHERE id = ?', [id]);
    res.json({ ok: true, deleted: id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;