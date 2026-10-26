'use strict';

/**
 * Full end-to-end validation of the PostgreSQL driver.
 *
 * 1. Boots a throwaway embedded PostgreSQL server
 * 2. Creates a fresh database
 * 3. Starts QRush against it (DB_CLIENT=postgres) on port 3001
 * 4. Seeds demo data and runs the whole order-flow test suite
 * 5. Tears everything down
 *
 * Run:  node scripts/test-postgres.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const EmbeddedPostgresModule = require('embedded-postgres');
const EmbeddedPostgres = EmbeddedPostgresModule.default || EmbeddedPostgresModule;

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'pg-e2e');
const PG_PORT = 55433;
const APP_PORT = 3001;

function log(msg) { console.log(msg); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A previous run that was killed abruptly can leave an orphaned postgres
 * process holding the port, which makes the next run fail with a cryptic
 * "address already in use". Clear it out first.
 */
async function killStrayPostgres() {
  const { execSync } = require('child_process');
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      // postgres.exe children of the embedded install.
      execSync('taskkill /F /IM postgres.exe /T', { stdio: 'ignore' });
    } else {
      execSync("pkill -f 'embedded-postgres' || true", { stdio: 'ignore' });
    }
    await sleep(1500);
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForHttp(url, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

async function main() {
  // Fresh cluster every run.
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  log('=== QRush · PostgreSQL end-to-end test ===\n');

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    // Force UTF-8 so currency symbols (₹) store correctly — the Windows
    // default would be WIN1252, which cannot represent them.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  let server = null;
  let stopped = false;
  const cleanup = async () => {
    if (server) { try { server.kill(); } catch (_) {} }
    if (!stopped) {
      try { await pg.stop(); } catch (_) {}
      stopped = true;
    }
    // Make sure nothing is left holding the port for the next run.
    await killStrayPostgres();
  };

  try {
    log('1/6  Booting embedded PostgreSQL...');
    await killStrayPostgres();
    try {
      await pg.initialise();
    } catch (err) {
      throw new Error(
        'Could not initialise the embedded PostgreSQL cluster.\n' +
        '  ' + err.message + '\n' +
        '  Usually a leftover postgres.exe from an earlier run is holding the port.\n' +
        '  Fix: close any running postgres.exe, or run:  taskkill /F /IM postgres.exe /T'
      );
    }
    await pg.start();
    await pg.createDatabase('tablenest_test');
    log('     PostgreSQL up on port ' + PG_PORT + ' ✓\n');

    log('2/6  Seeding demo data into PostgreSQL...');
    await runNode('src/db/seed.js', {
      DB_CLIENT: 'postgres',
      PGHOST: 'localhost', PGPORT: String(PG_PORT), PGUSER: 'postgres',
      PGPASSWORD: 'postgres', PGDATABASE: 'tablenest_test',
    });
    log('     Seeded ✓\n');

    log('3/6  Starting QRush against PostgreSQL...');
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        DB_CLIENT: 'postgres',
        PGHOST: 'localhost', PGPORT: String(PG_PORT), PGUSER: 'postgres',
        PGPASSWORD: 'postgres', PGDATABASE: 'tablenest_test',
        PORT: String(APP_PORT),
        BASE_URL: `http://localhost:${APP_PORT}`,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d.toString(); });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });

    const up = await waitForHttp(`http://localhost:${APP_PORT}/api/health`);
    if (!up) {
      console.error('Server did not start. Output:\n' + serverLog);
      throw new Error('QRush failed to boot on PostgreSQL');
    }
    if (!/database: PostgreSQL/.test(serverLog)) {
      console.error('Server log:\n' + serverLog);
      throw new Error('Server did not report the PostgreSQL driver');
    }
    log('     Booted with PostgreSQL driver ✓\n');

    log('4/6  Running the full order-flow test suite on PostgreSQL...');
    const test = spawn(process.execPath, ['scripts/test-flow.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { BASE_URL: `http://localhost:${APP_PORT}` }),
      stdio: 'inherit',
    });
    const code = await new Promise((res) => test.on('close', res));
    if (code !== 0) throw new Error('Flow tests failed on PostgreSQL (exit ' + code + ')');

    log('\n     Bill merge / add-on test...');
    await runNode('scripts/test-bill-merge.js', { BASE_URL: `http://localhost:${APP_PORT}` });

    log('\n     Platform console (super-admin) test...');
    await runNode('scripts/test-superadmin.js', { BASE_URL: `http://localhost:${APP_PORT}` });

    log('\n5/6  Verifying PostgreSQL-specific behaviour...');
    await verifyPostgresSpecifics(APP_PORT);

    log('6/6  Checking the data really landed in PostgreSQL...');
    await verifyRowsInPostgres(PG_PORT);

    log('\n✅ PostgreSQL migration fully validated — same behaviour as SQLite.\n');
  } catch (err) {
    console.error('\n❌ ' + err.message + '\n');
    await cleanup();
    process.exit(1);
  }

  await cleanup();
  process.exit(0);
}

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env),
      stdio: 'inherit',
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(script + ' failed (exit ' + code + ')'))));
    child.on('error', reject);
  });
}

/** Checks that only exist for the Postgres driver. */
async function verifyPostgresSpecifics(port) {
  const login = await (await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@demo.com', password: 'pass1234' }),
  })).json();
  const token = login.token;

  // 1. Stats endpoint uses the portable substr() date filter.
  const stats = await (await fetch(`http://localhost:${port}/api/orders/stats`, {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  if (typeof stats.today.orders_today !== 'number') throw new Error('stats broken on Postgres');
  log('     stats endpoint ✓ (orders today: ' + stats.today.orders_today + ')');

  // Baseline BEFORE we create anything.
  const before = await (await fetch(`http://localhost:${port}/api/menu`, {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  const countBefore = before.categories.length;

  // 2. INSERT ... RETURNING id -> lastInsertRowid must be a real number.
  const created = await (await fetch(`http://localhost:${port}/api/menu/categories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: 'PG Test Cat' }),
  })).json();
  if (!created.id || typeof created.id !== 'number') throw new Error('INSERT did not return a numeric id on Postgres');
  log('     INSERT ... RETURNING id ✓ (id=' + created.id + ')');

  const withNew = await (await fetch(`http://localhost:${port}/api/menu`, {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  if (withNew.categories.length !== countBefore + 1) throw new Error('new category was not persisted');
  log('     INSERT persisted ✓');

  // 3. Update + delete round-trip.
  const upd = await (await fetch(`http://localhost:${port}/api/menu/categories/${created.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: 'PG Test Cat Renamed' }),
  })).json();
  if (upd.name !== 'PG Test Cat Renamed') throw new Error('UPDATE failed on Postgres');
  log('     UPDATE ✓');

  const del = await (await fetch(`http://localhost:${port}/api/menu/categories/${created.id}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
  })).json();
  if (!del.ok) throw new Error('DELETE failed on Postgres');
  log('     DELETE ✓');

  const after = await (await fetch(`http://localhost:${port}/api/menu`, {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  if (after.categories.length !== countBefore) {
    log('     countBefore=' + countBefore + ' countAfter=' + after.categories.length);
    throw new Error('row count mismatch after delete');
  }
  log('     row counts consistent ✓');
}

/** Queries the database directly to prove the rows are really in PostgreSQL. */
async function verifyRowsInPostgres(pgPort) {
  const { Client } = require('pg');
  const client = new Client({
    host: 'localhost', port: pgPort, user: 'postgres', password: 'postgres', database: 'tablenest_test',
  });
  await client.connect();

  const tenants = await client.query('SELECT COUNT(*)::int AS c FROM tenants');
  const items = await client.query('SELECT COUNT(*)::int AS c FROM menu_items');
  const tables = await client.query('SELECT COUNT(*)::int AS c FROM tables');
  const orders = await client.query('SELECT COUNT(*)::int AS c FROM orders');
  const orderItems = await client.query('SELECT COUNT(*)::int AS c FROM order_items');
  const events = await client.query('SELECT COUNT(*)::int AS c FROM order_events');
  const seq = await client.query("SELECT last_value FROM tenants_id_seq");

  await client.end();

  const ok = tenants.rows[0].c === 1 && items.rows[0].c > 0 && tables.rows[0].c === 8
    && orders.rows[0].c > 0 && orderItems.rows[0].c > 0 && events.rows[0].c > 0;
  if (!ok) throw new Error('unexpected row counts in PostgreSQL');

  log('     tenants=' + tenants.rows[0].c + ' menu_items=' + items.rows[0].c
    + ' tables=' + tables.rows[0].c + ' orders=' + orders.rows[0].c
    + ' order_items=' + orderItems.rows[0].c + ' order_events=' + events.rows[0].c);
  log('     SERIAL sequence last_value=' + seq.rows[0].last_value + ' ✓');
}

main();
