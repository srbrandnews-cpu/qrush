'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');

const { ensureSchema } = require('./src/db/init');
const { runMigrations } = require('./src/db/migrations');
const push = require('./src/services/push');
const { initSocket } = require('./src/realtime/socket');
const { dialect } = require('./src/config/db');
const { runWithOrigin } = require('./src/utils/request-context');
const {
  securityHeaders,
  blockBadRequests,
  loginLimiter,
  ownerLoginLimiter,
  otpLimiter,
  writeLimiter,
  apiLimiter,
} = require('./src/middleware/security');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(securityHeaders);
app.use(blockBadRequests);
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// Broad protection: cap every API IP, then tighter limits on auth-sensitive
// endpoints. Write requests (orders, menu edits, signup, upgrades) get their
// own bucket so a single phone cannot flood the database.
app.use('/api', apiLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/public/free-qr/login', ownerLoginLimiter);
app.use('/api/public/free-qr/send-otp', otpLimiter);
app.use('/api/public/free-qr/verify-otp', otpLimiter);
app.use('/api/public/free-qr/reset-password', otpLimiter);
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return writeLimiter(req, res, next);
});

// Make the request's own origin visible to helpers that build absolute URLs
// (QR codes). Means a deployment never needs a hard-coded BASE_URL.
app.use((req, res, next) => {
  const host = req.get('host');
  runWithOrigin(host ? `${req.protocol}://${host}` : '', next);
});

// --- API routes ---
// Only the Free QR product is live. Table-ordering routes (menu / tables /
// orders / requests / voice) were moved to archive/main-website/ and are no
// longer mounted. `auth` + `admin` stay because the Super Admin console needs
// them, and `public` serves the free-QR menus, dashboard and ordering APIs.
app.use('/api/auth', require('./src/routes/auth.routes'));
app.use('/api/admin', require('./src/routes/admin.routes'));
const publicRouter = require('./src/routes/public.routes');
app.use('/api/public', publicRouter);

// Public hosted free-menu page. The QR code points at /m/<slug>, so this has
// to live at the site root (not under /api/public).
app.get('/m/:slug', publicRouter.hostedMenuPage);
app.get('/m/:slug/logo', publicRouter.hostedMenuLogo);
app.get('/m/:slug/menu', publicRouter.hostedMenuMenu);
app.get('/m/:slug/menu/:idx', publicRouter.hostedMenuMenu);
app.get('/m/:slug/go/:network', publicRouter.hostedMenuGo);

app.get('/api/health', async (req, res) => {
  const mem = process.memoryUsage();
  const health = {
    ok: true,
    name: 'QRush',
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    node_version: process.version,
  };
  // Warn if memory usage is high (potential crash risk)
  if (mem.heapUsed / mem.heapTotal > 0.85) {
    console.warn('[HEALTH] High memory usage:', Math.round(mem.heapUsed / mem.heapTotal * 100) + '%');
  }
  res.json(health);
});

// --- Static assets (CSS/JS/service worker) ---
// Code files are revalidated on every load (ETag -> cheap 304), so a browser
// can never keep running an old version of admin.js / kitchen.js. Images and
// icons are cached longer since they rarely change.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpg|jpeg|gif|svg|ico|webp|mp4|webm)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 1 week
    } else {
      // HTML / JS / CSS / JSON / sw.js — always revalidate.
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// --- HTML screens ---
// The site now exposes ONLY the Free Digital QR Menu Generator. The old
// table-ordering screens (admin / kitchen / cashier / login / menu / waiting)
// live in archive/main-website/public/ and are not served any more.
const page = (file) => (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', file));
};
app.get('/', page('free-qr.html'));
app.get('/free-qr', page('free-qr.html'));
app.get('/superadmin', page(path.join('superadmin', 'index.html')));
// Kitchen board for a free hosted menu (orders scanned from the free QR card).
app.get('/m/:slug/kitchen', page('free-qr-kitchen.html'));

// Keep-alive: ping self every 10 min to reduce Render free-tier sleep.
if (process.env.RENDER || process.env.NODE_ENV === 'production') {
  const http = require('http');
  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
  setInterval(() => {
    const url = `${keepAliveUrl}/api/health`;
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, (res) => {
      console.log('[keepalive] ping', res.statusCode, new Date().toISOString());
    }).on('error', (e) => {
      console.log('[keepalive] err', e.message);
    });
  }, 10 * 60 * 1000);
}
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

// --- Central error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  if (req.path.startsWith('/api')) {
    // Never leak SQL / stack details to clients in production.
    const isProd = process.env.NODE_ENV === 'production';
    const message = status >= 500 && isProd ? 'Server error' : (err.message || 'Server error');
    return res.status(status).json({ error: message });
  }
  res.status(status).send('Something went wrong');
});

// --- HTTP + WebSocket server ---
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
initSocket(server);

/**
 * Boot sequence: create tables if first run, prepare VAPID keys, then listen.
 * Schema creation is awaited so Postgres is ready before we accept traffic.
 */
/**
 * Catches the mistakes that silently break a deployment.
 * These are the exact things that go wrong on serverless platforms.
 */
function checkProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems = [];

  if (dialect() === 'sqlite') {
    problems.push(
      'DB_CLIENT=sqlite par production mat chalao — serverless platforms ka filesystem ' +
      'temporary hota hai, database har deploy par reset ho jayega. ' +
      'DB_CLIENT=postgres set karein (Neon / Cloud SQL / Supabase).'
    );
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    problems.push(
      'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variables mein set nahi hain. ' +
      'Temporary filesystem par keys har deploy par badal jayengi aur customers ke ' +
      'notifications toot jayenge. `node scripts/generate-vapid.js` chala kar set karein.'
    );
  }
  if (process.env.BASE_URL && !/^https:\/\//.test(process.env.BASE_URL)) {
    problems.push(
      'BASE_URL https:// se start nahi ho raha — QR codes galat link bana denge. ' +
      '(Base_URL khali chhod dein to QR code khud request ke host se banega.)'
    );
  }
  if (process.env.JWT_SECRET === 'change-me-to-a-long-random-string' || !process.env.JWT_SECRET) {
    problems.push('JWT_SECRET set nahi hai (ya default hai) — please apna random secret daalein.');
  }
  if (!process.env.SUPER_ADMIN_EMAILS) {
    problems.push(
      'SUPER_ADMIN_EMAILS set nahi hai — production mein Super Admin console band rahega. ' +
      'Render → Environment mein apna email daalein (comma-separated for multiple admins).'
    );
  }

  if (problems.length) {
    console.warn('\n⚠️  Production configuration warnings:\n');
    problems.forEach((p) => console.warn('   • ' + p));
    console.warn('');
  }
}

/**
 * Warns when any account still uses the demo password published in the
 * README (public repo). Does not block boot — the owner must change it.
 */
async function checkWeakPasswords() {
  try {
    const bcrypt = require('bcryptjs');
    const { query } = require('./src/config/db');
    const users = await query('SELECT email, password_hash FROM users');
    const weak = (users || []).filter(
      (u) => u.password_hash && bcrypt.compareSync('pass1234', u.password_hash)
    );
    if (weak.length) {
      console.warn('\n⚠️  SECURITY WARNING: demo password "pass1234" still active on:');
      weak.forEach((u) => console.warn('   • ' + u.email));
      console.warn('   Free QR → Owner Login → Forgot password se turant reset karein.\n');
    }
  } catch (_) {
    // Never block boot because of a warning check.
  }
}

async function boot() {
  try {
    await ensureSchema();
    await runMigrations();
    push.init();
    checkProductionConfig();
    await checkWeakPasswords();

    server.listen(PORT, () => {
      const db = dialect() === 'postgres' ? 'PostgreSQL' : 'SQLite';
      console.log(`\n🚀 QRush running  (database: ${db})`);
      console.log(`   Free QR   http://localhost:${PORT}/`);
      console.log(`   Super     http://localhost:${PORT}/superadmin`);
      console.log(`   Menus     /m/<slug>   ·   Kitchen  /m/<slug>/kitchen\n`);
    });
  } catch (err) {
    console.error('\n❌ Failed to start QRush:\n', err);
    process.exit(1);
  }
}

boot();
