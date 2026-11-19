'use strict';

const jwt = require('jsonwebtoken');
const { get } = require('../config/db');

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const COOKIE_NAME = 'tn_token';

function signToken(user) {
  return jwt.sign(
    { uid: user.id, tenantId: user.tenant_id, role: user.role, name: user.name, email: user.email },
    SECRET,
    { expiresIn: '12h' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (_) {
    return null;
  }
}

/**
 * Free-QR menu owners are not staff users — they live in `free_qr_menus`.
 * They get their own long-lived token so the generator page can show
 * "my restaurant" without touching the staff auth flow.
 */
function signFreeQrToken(row) {
  return jwt.sign({ scope: 'freeqr', fq: row.id, slug: row.slug }, SECRET, { expiresIn: '180d' });
}

function verifyFreeQrToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    if (!payload || payload.scope !== 'freeqr' || !payload.fq) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// Pull token from `Authorization: Bearer ...`. The cookie is deliberately not
// used: it is shared by every screen on the browser, so it would leak one
// role's session into another role's tab.
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

// Require a logged-in staff user; attaches req.user.
async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    const payload = token && verifyToken(token);
    // Free-QR owner tokens carry { scope:'freeqr', fq } and never a uid —
    // they must use the free-QR endpoints, not the staff/admin ones.
    if (!payload || !payload.uid) {
      return res.status(401).json({ error: 'Login required' });
    }
    // Make sure the account still exists and is active.
    const user = await get('SELECT id, tenant_id, role, name, email FROM users WHERE id = ? AND is_active = 1', [payload.uid]);
    if (!user) {
      return res.status(401).json({ error: 'Account disabled' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// Restrict to specific roles, e.g. requireRole('owner','kitchen').
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Login required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed for your role' });
    }
    next();
  };
}

// Super-admin check: only the platform owner (by email) can manage tenants.
// Configure extra platform admins with a comma-separated SUPER_ADMIN_EMAILS
// env var. In production there is NO hard-coded fallback: the env var must be
// set, otherwise nobody can access the platform console. The local demo owner
// is only allowed outside production.
const DEFAULT_SUPER_ADMIN_EMAILS = process.env.NODE_ENV === 'production'
  ? ''
  : 'srbrandnews@gmail.com,owner@demo.com';
const SUPER_ADMIN_EMAILS = String(process.env.SUPER_ADMIN_EMAILS || DEFAULT_SUPER_ADMIN_EMAILS)
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

function isSuperAdmin(user) {
  if (!user || !user.email) return false;
  return SUPER_ADMIN_EMAILS.includes(String(user.email).toLowerCase());
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
}

module.exports = {
  signToken, verifyToken, requireAuth, requireRole, requireSuperAdmin,
  isSuperAdmin, SUPER_ADMIN_EMAILS, COOKIE_NAME, SECRET,
  signFreeQrToken, verifyFreeQrToken,
};
