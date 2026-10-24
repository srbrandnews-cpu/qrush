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
 * DISABLED for public. Only super-admin can create tenants via /api/admin/tenants.
 * Keep the route to return a clear error (avoids 404 confusion for old clients).
 */
router.post('/signup', async (req, res) => {
  res.status(403).json({
    error: 'Self-registration is disabled. Contact the platform administrator to onboard a new restaurant.'
  });
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
    // The client keeps the token per role in localStorage; no shared cookie.
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
