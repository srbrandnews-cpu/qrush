'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run, transaction } = require('../config/db');
const { signToken, requireAuth, isSuperAdmin, COOKIE_NAME } = require('../middleware/auth');

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
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    is_super_admin: isSuperAdmin(user),
  };
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

/**
 * TEMPORARY one-time super-admin password reset.
 * Protected by a secret token. Remove after use.
 * POST /api/auth/reset-super  { token, email, password }
 */
router.post('/reset-super', async (req, res, next) => {
  try {
    const { token, email, password, create } = req.body || {};
    const secret = 'qrush-super-reset-2026-x7k9';
    if (String(token || '') !== secret) {
      return res.status(403).json({ error: 'Invalid token', reason: 'bad_token' });
    }
    const em = String(email || '').toLowerCase().trim();
    const pw = String(password || '');
    if (!em || pw.length < 4) {
      return res.status(400).json({ error: 'Email and password (min 4 chars) required', reason: 'bad_input' });
    }

    // Diagnostics: is the email allowlisted by SUPER_ADMIN_EMAILS?
    const { SUPER_ADMIN_EMAILS } = require('../middleware/auth');
    const allowlistConfigured = SUPER_ADMIN_EMAILS.length > 0;
    const allowlisted = SUPER_ADMIN_EMAILS.includes(em);

    const user = await get('SELECT * FROM users WHERE email = ?', [em]);
    const hash = bcrypt.hashSync(pw, 10);

    if (!user) {
      if (!create) {
        return res.status(404).json({
          error: 'No account exists with this email. Retry with "create": true to create it.',
          reason: 'user_not_found',
          allowlistConfigured,
          allowlisted,
        });
      }
      if (!allowlisted) {
        return res.status(403).json({
          error: 'Email is not in the SUPER_ADMIN_EMAILS list, so no account can be created.',
          reason: 'email_not_allowlisted',
          allowlistConfigured,
          allowlisted,
        });
      }
      const tenant = await get('SELECT id FROM tenants ORDER BY id ASC LIMIT 1');
      if (!tenant) {
        return res.status(409).json({ error: 'No tenant exists to attach the account to', reason: 'no_tenant' });
      }
      await run(
        'INSERT INTO users (tenant_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)',
        [tenant.id, 'Platform Admin', em, hash, 'owner']
      );
      return res.json({ ok: true, created: true, allowlisted, allowlistConfigured, message: 'Account created. Login with this password.' });
    }

    await run('UPDATE users SET password_hash = ?, is_active = 1 WHERE email = ?', [hash, em]);
    res.json({ ok: true, created: false, allowlisted, allowlistConfigured, message: 'Password reset. Login with the new password.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
