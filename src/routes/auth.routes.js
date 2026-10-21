'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run, transaction } = require('../config/db');
const { signToken, requireAuth, COOKIE_NAME } = require('../middleware/auth');

const router = express.Router();

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

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/**
 * POST /api/auth/signup
 * Creates a restaurant (tenant) + its owner account in one step.
 */
router.post('/signup', async (req, res, next) => {
  try {
    const { restaurant, name, email, password, phone } = req.body || {};
    if (!restaurant || !name || !email || !password) {
      return res.status(400).json({ error: 'Restaurant name, your name, email and password are required' });
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

    const user = await get('SELECT id, tenant_id, name, email, role FROM users WHERE id = ?', [result.userId]);
    const token = signToken(user);
    res.status(201).json({
      token,
      user: publicUser(user),
      tenant: await getTenant(result.tenantId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login  { email, password }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await get('SELECT * FROM users WHERE email = ? AND is_active = 1', [String(email).toLowerCase()]);
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = signToken(user);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
    res.json({ token, user: publicUser(user), tenant: await getTenant(user.tenant_id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

/**
 * GET /api/auth/me
 */
router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user), tenant: await getTenant(req.user.tenant_id) });
});

async function getTenant(tenantId) {
  const t = await get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  return t || null;
}

module.exports = router;
