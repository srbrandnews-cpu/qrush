'use strict';

/**
 * Dependency-free security hardening.
 *
 * Adds:
 *   - Safe HTTP response headers (clickjacking / MIME-sniffing / referrer).
 *   - In-memory rate limiting for login, OTP and write endpoints.
 *   - Blocking of common scanner paths (.env, .git, wp-admin, phpMyAdmin ...).
 *   - Hiding X-Powered-By.
 *
 * Everything here is intentionally lightweight: a single Node process on
 * Render's free tier does not need an external store. Limits reset on deploy.
 */

/* ------------------------------------------------------------------ */
/*  Response headers                                                   */
/* ------------------------------------------------------------------ */

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Same-origin iframes still work (free-QR embed + menu preview);
  // other sites cannot frame the app.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(), geolocation=(), payment=()'
  );

  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Real client IP for rate limiting.
 *
 * `trust proxy` is enabled (Render + Cloudflare in front), which makes
 * `req.ip` come from the client-supplied X-Forwarded-For header - so a
 * caller can rotate fake IPs and never hit a limit. Cloudflare always
 * overwrites `CF-Connecting-IP` with the real edge IP and strips copies
 * sent by the browser, so that header is authoritative when present.
 */
function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * One Map per limiter.
 *   keyMode 'ip'      -> key = client IP (+ optional extraKey suffix)
 *   keyMode 'account' -> key = extraKey(req) only (e.g. the email or phone
 *                        being targeted), so rotating IPs does not help.
 */
function createRateLimiter({ windowMs, max, message, extraKey, keyMode }) {
  const hits = new Map();

  // Drop expired entries periodically so memory stays bounded.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000));
  if (typeof cleanup.unref === 'function') cleanup.unref();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    let key;
    if (keyMode === 'account') {
      const value = extraKey ? String(extraKey(req) || '').trim().toLowerCase() : '';
      // Nothing to key on (missing email/phone) - let the route validate it.
      if (!value) return next();
      key = 'acc:' + value;
    } else {
      key = clientIp(req);
      if (extraKey) key += '|' + extraKey(req);
    }

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    // Show the tightest limit that applies (login 10, writes 120, API 600).
    const current = Number(res.getHeader('X-RateLimit-Limit') || 0);
    if (!current || max < current) {
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
    }

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || 'Too many requests. Please try again shortly.',
      });
    }
    next();
  };
}

// Login: 10 attempts per 15 minutes per IP.
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Try again in 15 minutes.',
});

// Owner login for the free-QR dashboard: 15 per 15 minutes.
const ownerLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: 'Too many login attempts. Try again in 15 minutes.',
});

// OTP / password reset: 5 per 15 minutes per IP.
const otpLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many OTP requests. Try again in 15 minutes.',
});

// Per-account buckets: brute force from many IPs still hits these.
// Staff login: 12 tries per 15 minutes for the same email.
const loginAccountLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 12,
  keyMode: 'account',
  extraKey: (req) => (req.body && req.body.email) || '',
  message: 'Is account par bahut zyada attempts ho gaye. 15 minute baad try karein.',
});

// Free-QR owner login: 12 tries per 15 minutes for the same phone.
const ownerLoginAccountLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 12,
  keyMode: 'account',
  extraKey: (req) => (req.body && req.body.phone) || '',
  message: 'Is number par bahut zyada attempts ho gaye. 15 minute baad try karein.',
});

// Password reset requests: 3 per hour per phone.
const resetAccountLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyMode: 'account',
  extraKey: (req) => (req.body && req.body.phone) || '',
  message: 'Is number ke liye bahut zyada reset requests. 1 ghante baad try karein.',
});

// Signup / upgrade requests: 20 per hour per IP.
const signupLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: 'Too many requests from this network. Try again later.',
});

// Every other write (orders, menu edits, feedback ...): 120 per 5 minutes.
const writeLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: 'Too many requests. Please slow down.',
});

// Broad API ceiling: 600 requests per minute per IP.
const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: 'Too many requests. Please slow down.',
});

/* ------------------------------------------------------------------ */
/*  Scanner / exploit path blocking                                    */
/* ------------------------------------------------------------------ */

const BLOCKED_PATHS = [
  /^\/\.env/i,
  /^\/\.git/i,
  /^\/\.aws/i,
  /^\/\.ssh/i,
  /^\/wp-(admin|login|content|includes)/i,
  /^\/phpmyadmin/i,
  /^\/pma\//i,
  /^\/myadmin/i,
  /^\/vendor\//i,
  /^\/config\.(json|php|yml|yaml)$/i,
  /^\/server-status$/i,
  /^\/cgi-bin\//i,
  /\.php$/i,
];

function blockBadRequests(req, res, next) {
  if (req.method === 'TRACE' || req.method === 'TRACK') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const p = req.path || '';
  for (const re of BLOCKED_PATHS) {
    if (re.test(p)) {
      // Pretend the file does not exist.
      if (p.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
      return res.status(404).type('text/plain').send('Not found');
    }
  }
  next();
}

/* ------------------------------------------------------------------ */
/*  Request size guard                                                 */
/* ------------------------------------------------------------------ */

/**
 * The global JSON parser allows 20 MB (menu photos are sent as data URLs).
 * Auth / OTP routes never need that much, so keep them tiny to remove an
 * easy memory-exhaustion vector.
 */
function limitBodySize(maxBytes) {
  return function bodySizeGuard(req, res, next) {
    const len = Number(req.headers['content-length'] || 0);
    if (len > maxBytes) return res.status(413).json({ error: 'Payload too large' });
    next();
  };
}

module.exports = {
  securityHeaders,
  blockBadRequests,
  createRateLimiter,
  limitBodySize,
  loginLimiter,
  loginAccountLimiter,
  ownerLoginLimiter,
  ownerLoginAccountLimiter,
  otpLimiter,
  resetAccountLimiter,
  signupLimiter,
  writeLimiter,
  apiLimiter,
};
