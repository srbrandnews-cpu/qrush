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

/** One Map per limiter, keyed by client IP (+ optional extra key). */
function createRateLimiter({ windowMs, max, message, extraKey }) {
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
    let key = req.ip || req.socket.remoteAddress || 'unknown';
    if (extraKey) key += '|' + extraKey(req);

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    // Do not overwrite a tighter limiter's headers (login runs before writes).
    if (!res.getHeader('X-RateLimit-Limit')) {
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

module.exports = {
  securityHeaders,
  blockBadRequests,
  createRateLimiter,
  loginLimiter,
  ownerLoginLimiter,
  otpLimiter,
  signupLimiter,
  writeLimiter,
  apiLimiter,
};
