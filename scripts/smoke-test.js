'use strict';

/**
 * End-to-end smoke test with a throwaway SQLite database and a real server.
 *
 *   npm test
 *
 * It never touches the development or production database: a temp DB file and
 * a random port are created for each run, then removed afterwards.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrush-smoke-'));
const dbFile = path.join(tmp, 'smoke.db');
let child = null;
let base = '';
let passed = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(port) {
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DB_CLIENT: 'sqlite',
      DB_FILE: dbFile,
      DB_DIR: tmp,
      BASE_URL: base,
      JWT_SECRET: 'smoke-test-secret-not-for-production',
      SUPER_ADMIN_EMAILS: 'owner@demo.com',
      LEGACY_HOSTS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += String(d); });
  child.stderr.on('data', (d) => { logs += String(d); });

  // Migrations on a fresh DB can take a few seconds on a cold CI runner.
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}): ${logs.slice(-1200)}`);
    try {
      const r = await fetch(base + '/api/health');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not start: ${logs.slice(-1200)}`);
}

async function req(url, opts = {}) {
  const r = await fetch(base + url, {
    method: opts.method || 'GET',
    headers: { ...(opts.headers || {}) },
    body: opts.body,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML or plain text */ }
  return { status: r.status, headers: r.headers, text, json };
}

function ok(label, condition, detail) {
  assert.ok(condition, `${label}${detail ? ' — ' + detail : ''}`);
  passed += 1;
  console.log('  ✓ ' + label);
}

async function run() {
  const port = await freePort();
  await startServer(port);

  const health = await req('/api/health');
  ok('health endpoint', health.status === 200);

  const home = await req('/');
  ok('homepage loads', home.status === 200 && /QRush/i.test(home.text));

  const core = await req('/js/free-qr-core.js?v=1');
  ok('extracted dashboard JS is served', core.status === 200 && /javascript/.test(core.headers.get('content-type') || ''));

  const menuCss = await req('/css/menu.css?v=7');
  ok('customer menu CSS is served', menuCss.status === 200);

  ok('security headers', health.headers.get('x-content-type-options') === 'nosniff'
    && health.headers.get('x-frame-options') === 'SAMEORIGIN');

  ok('admin API requires login', (await req('/api/admin/tenants')).status === 401);
  ok('owner items API requires login', (await req('/api/public/free-qr/items')).status === 401);

  const reset = await req('/api/public/free-qr/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '9000000005', password: 'hacked123' }),
  });
  ok('phone-only password reset is closed', reset.status === 403 && reset.json && reset.json.code === 'contact_support');

  const oversized = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x'.repeat(100 * 1024), password: 'x' }),
  });
  ok('oversized auth body rejected', oversized.status === 413);

  ok('bad login rejected', (await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrongpass' }),
  })).status === 401);

  // Full owner journey on a throwaway account.
  const phone = '9999988888';
  const otpRes = await req('/api/public/free-qr/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  ok('signup OTP issued for a new number', otpRes.status === 200 && /^\d{6}$/.test(String(otpRes.json && otpRes.json.otp)));

  const create = await req('/api/public/free-qr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restaurant: 'Smoke Test Cafe',
      owner_name: 'Smoke Tester',
      phone,
      password: 'smoke1234',
      otp: otpRes.json.otp,
      items: [{
        name: 'Test Dosa',
        price: 120,
        category: 'Main',
        description: 'Crisp golden dosa',
        half: 60,
        full: 120,
      }],
    }),
  });
  ok('menu created', create.status === 201 && !!create.json && !!create.json.slug, JSON.stringify(create.json));
  const { slug, token } = create.json;
  ok('owner token issued', !!token);

  const hosted = await req(`/m/${slug}`);
  ok('hosted menu renders', hosted.status === 200
    && hosted.text.includes('Smoke Test Cafe')
    && hosted.text.includes('Crisp golden dosa')
    && hosted.text.includes('qm-welcome'));

  const ownerMe = await req('/api/public/free-qr/me', { headers: { Authorization: `Bearer ${token}` } });
  ok('owner dashboard data loads', ownerMe.status === 200 && (ownerMe.json.items || []).length === 1);

  const item = ownerMe.json.items[0];
  const updated = await req('/api/public/free-qr/items', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ ...item, name: 'Updated Dosa', description: 'New description' }] }),
  });
  ok('owner can edit items', updated.status === 200 && updated.json.items[0].name === 'Updated Dosa');

  const hosted2 = await req(`/m/${slug}`);
  ok('edited item appears on hosted menu', hosted2.text.includes('Updated Dosa') && hosted2.text.includes('New description'));

  const otpAgain = await req('/api/public/free-qr/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  ok('OTP never leaked for an existing account', otpAgain.status === 409 && !otpAgain.json.otp);

  console.log(`\nSmoke test passed: ${passed} checks.`);
}

(async () => {
  try {
    await run();
  } catch (err) {
    console.error('\nSmoke test FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})();
