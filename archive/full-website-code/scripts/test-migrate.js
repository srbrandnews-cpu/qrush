'use strict';

/**
 * Validates scripts/sqlite-to-postgres.js without needing a cloud database:
 * boots a throwaway embedded PostgreSQL, copies the real local SQLite data,
 * compares row counts, then checks the safety rails (re-run / --truncate).
 *
 * Run:  node scripts/test-migrate.js
 */

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const EmbeddedPostgresModule = require('embedded-postgres');
const EmbeddedPostgres = EmbeddedPostgresModule.default || EmbeddedPostgresModule;
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'pg-migrate');
const PG_PORT = 55434;
const DB_NAME = 'tablenest_migrate';
const SQLITE_FILE = path.join(ROOT, 'data', 'tablenest.db');

const TABLES = [
  'tenants', 'users', 'menu_categories', 'menu_items', 'tables',
  'push_subscriptions', 'orders', 'order_items', 'notifications', 'order_events',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function killStrayPostgres() {
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM postgres.exe /T', { stdio: 'ignore' });
    } else {
      execSync("pkill -f 'embedded-postgres' || true", { stdio: 'ignore' });
    }
    await sleep(1500);
  } catch (_) { /* nothing running */ }
}

function sqliteCounts() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(SQLITE_FILE, { readOnly: true });
  const out = {};
  for (const t of TABLES) {
    try {
      out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    } catch (_) {
      out[t] = 0;
    }
  }
  db.close();
  return out;
}

function runMigrate(extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/sqlite-to-postgres.js', ...extraArgs], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        DB_FILE: SQLITE_FILE,
        PGHOST: 'localhost',
        PGPORT: String(PG_PORT),
        PGUSER: 'postgres',
        PGPASSWORD: 'postgres',
        PGDATABASE: DB_NAME,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  if (!fs.existsSync(SQLITE_FILE)) throw new Error('No local SQLite DB at ' + SQLITE_FILE);

  console.log('=== QRush · migration script test ===\n');
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await killStrayPostgres();

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  let client = null;

  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(DB_NAME);
    console.log('1/5  Embedded PostgreSQL up on ' + PG_PORT + ' ✓\n');

    console.log('2/5  Running migration...');
    const first = await runMigrate();
    if (first.code !== 0) {
      console.error(first.out);
      throw new Error('Migration failed (exit ' + first.code + ')');
    }
    console.log(first.out);

    console.log('3/5  Comparing row counts...');
    const source = sqliteCounts();
    client = new Client({ host: 'localhost', port: PG_PORT, user: 'postgres', password: 'postgres', database: DB_NAME });
    await client.connect();

    for (const t of TABLES) {
      const res = await client.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
      const got = res.rows[0].c;
      if (got !== source[t]) {
        throw new Error(`${t}: SQLite has ${source[t]} rows but PostgreSQL has ${got}`);
      }
      console.log(`     ${t.padEnd(20)} ${String(got).padStart(5)} ✓`);
    }

    console.log('\n4/5  Re-run without --truncate must be refused...');
    const second = await runMigrate();
    if (second.code === 0) throw new Error('Re-run without --truncate should have failed');
    if (!/already has data/.test(second.out)) throw new Error('Expected a clear "already has data" error');
    console.log('     refused with a clear message ✓');

    console.log('\n5/5  Re-run with --truncate must replace cleanly...');
    const third = await runMigrate(['--truncate']);
    if (third.code !== 0) {
      console.error(third.out);
      throw new Error('--truncate run failed');
    }
    for (const t of TABLES) {
      const res = await client.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
      if (res.rows[0].c !== source[t]) throw new Error(t + ' count changed after --truncate');
    }

    // A fresh INSERT must get the next id, not collide with a migrated row.
    const before = await client.query('SELECT COALESCE(MAX(id), 0)::int AS m FROM menu_categories');
    const next = await client.query("INSERT INTO menu_categories (tenant_id, name) VALUES ($1, 'Post-migration test') RETURNING id", [1]);
    if (next.rows[0].id !== before.rows[0].m + 1) {
      throw new Error(`SERIAL sequence wrong after migration (expected ${before.rows[0].m + 1}, got ${next.rows[0].id})`);
    }
    await client.query('DELETE FROM menu_categories WHERE id = $1', [next.rows[0].id]);
    console.log('     replacement clean + SERIAL sequence advanced ✓');

    console.log('\n✅ Migration script verified end-to-end.\n');
  } finally {
    if (client) await client.end().catch(() => {});
    await pg.stop().catch(() => {});
    await killStrayPostgres();
  }
}

main().catch((err) => {
  console.error('\n❌ ' + err.message + '\n');
  process.exit(1);
});
