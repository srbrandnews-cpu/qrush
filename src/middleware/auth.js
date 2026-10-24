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
    if (!payload) {
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
// Allow srbrandnews@gmail.com (your account) AND the demo owner for testing.
const SUPER_ADMIN_EMAILS = ['srbrandnews@gmail.com', 'owner@demo.com'];

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  if (!SUPER_ADMIN_EMAILS.includes(req.user.email)) {
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
}

module.exports = { signToken, verifyToken, requireAuth, requireRole, requireSuperAdmin, COOKIE_NAME, SECRET };
