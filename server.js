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

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// Make the request's own origin visible to helpers that build absolute URLs
// (QR codes). Means a deployment never needs a hard-coded BASE_URL.
app.use((req, res, next) => {
  const host = req.get('host');
  runWithOrigin(host ? `${req.protocol}://${host}` : '', next);
});

// --- API routes ---
app.use('/api/auth', require('./src/routes/auth.routes'));
app.use('/api/menu', require('./src/routes/menu.routes'));
app.use('/api/tables', require('./src/routes/table.routes'));
app.use('/api/orders', require('./src/routes/order.routes'));
app.use('/api/requests', require('./src/routes/request.routes'));
app.use('/api/admin', require('./src/routes/admin.routes'));
app.use('/api/push', require('./src/routes/push.routes'));
app.use('/api/voice', require('./src/routes/voice.routes'));
const publicRouter = require('./src/routes/public.routes');
app.use('/api/public', publicRouter);

// Public hosted free-menu page. The QR code points at /m/<slug>, so this has
// to live at the site root (not under /api/public).
app.get('/m/:slug', publicRouter.hostedMenuPage);
app.get('/m/:slug/logo', publicRouter.hostedMenuLogo);
app.get('/m/:slug/menu', publicRouter.hostedMenuMenu);
app.get('/m/:slug/menu/:idx', publicRouter.hostedMenuMenu);
app.get('/m/:slug/go/:network', publicRouter.hostedMenuGo);

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'QRush' }));

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
const page = (file) => (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', file));
};
app.get('/', page('index.html'));
app.get('/login', page(path.join('login', 'index.html')));
app.get('/admin', page(path.join('admin', 'index.html')));
app.get('/superadmin', page(path.join('superadmin', 'index.html')));
app.get('/kitchen', page(path.join('kitchen', 'index.html')));
app.get('/cashier', page(path.join('cashier', 'index.html')));
app.get('/r/:slug', page(path.join('wait', 'index.html')));
app.get('/menu', page(path.join('menu', 'index.html')));
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
    return res.status(status).json({ error: err.message || 'Server error' });
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

  if (problems.length) {
    console.warn('\n⚠️  Production configuration warnings:\n');
    problems.forEach((p) => console.warn('   • ' + p));
    console.warn('');
  }
}

async function boot() {
  try {
    await ensureSchema();
    await runMigrations();
    push.init();
    checkProductionConfig();

    server.listen(PORT, () => {
      const db = dialect() === 'postgres' ? 'PostgreSQL' : 'SQLite';
      console.log(`\n🚀 QRush running  (database: ${db})`);
      console.log(`   Home      http://localhost:${PORT}/`);
      console.log(`   Admin     http://localhost:${PORT}/admin`);
      console.log(`   Kitchen   http://localhost:${PORT}/kitchen`);
      console.log(`   Cashier   http://localhost:${PORT}/cashier`);
      console.log(`   QR codes  Admin panel -> Tables & QR tab\n`);
    });
  } catch (err) {
    console.error('\n❌ Failed to start QRush:\n', err);
    process.exit(1);
  }
}

boot();
