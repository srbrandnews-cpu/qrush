'use strict';

/**
 * Copy the local SQLite database into PostgreSQL (Neon / Render / Supabase).
 *
 * Run:
 *   DATABASE_URL="postgresql://...?sslmode=require" node scripts/sqlite-to-postgres.js
 *
 * Options:
 *   --truncate   wipe the target tables first (use when re-running)
 *   --dry-run    show what would be copied, change nothing
 *
 * IDs are preserved, so staff logins and table QR tokens stay exactly the same.
 * The target must be empty (or --truncate must be passed) to avoid mixing data.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Parent tables first — the order matters because of foreign keys.
const TABLES = [
  'tenants',
  'users',
  'menu_categories',
  'menu_items',
  'tables',
  'push_subscriptions',
  'orders',
  'order_items',
  'notifications',
  'order_events',
];

const SOURCE_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'tablenest.db');
const CHUNK = 100;

function pgConfig() {
  const cfg = { connectionTimeoutMillis: 15000 };
  if (process.env.DATABASE_URL) {
    cfg.connectionString = process.env.DATABASE_URL;
  } else {
    cfg.host = process.env.PGHOST || 'localhost';
    cfg.port = process.env.PGPORT ? Number(process.env.PGPORT) : 5432;
    cfg.user = process.env.PGUSER || 'postgres';
    cfg.password = process.env.PGPASSWORD || '';
    cfg.database = process.env.PGDATABASE || 'postgres';
  }
  if (process.env.PGSSL === 'no-verify') cfg.ssl = { rejectUnauthorized: false };
  else if (process.env.PGSSL === 'false') cfg.ssl = false;
  return cfg;
}

function openSource() {
  if (!fs.existsSync(SOURCE_FILE)) {
    throw new Error('SQLite database not found: ' + SOURCE_FILE);
  }
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(SOURCE_FILE, { readOnly: true });
}

function sourceTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set(rows.map((r) => r.name));
}

function sourceColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

async function targetColumns(client, table) {
  const res = await client.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function copyTable(client, db, table, columns, dryRun) {
  const rows = db
    .prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}` +
      (columns.includes('id') ? ' ORDER BY id' : ''))
    .all();

  if (!rows.length) return { table, copied: 0 };

  if (dryRun) return { table, copied: rows.length };

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const tuples = chunk.map((row) => {
      const placeholders = columns.map((col) => {
        values.push(row[col] === undefined ? null : row[col]);
        return '$' + values.length;
      });
      return '(' + placeholders.join(', ') + ')';
    });

    await client.query(
      `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES ` +
        tuples.join(', ') +
        ' ON CONFLICT (id) DO NOTHING',
      values
    );
  }

  return { table, copied: rows.length };
}

async function resetSequences(client) {
  for (const table of TABLES) {
    await client.query(
      `SELECT setval(
         pg_get_serial_sequence($1, 'id'),
         COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1),
         (SELECT COUNT(*) > 0 FROM ${quoteIdent(table)})
       )`,
      [table]
    );
  }
}

async function countRows(client, table) {
  const res = await client.query(`SELECT COUNT(*)::int AS c FROM ${quoteIdent(table)}`);
  return res.rows[0].c;
}

async function main() {
  const args = process.argv.slice(2);
  const truncate = args.includes('--truncate');
  const dryRun = args.includes('--dry-run');

  console.log('\n=== TableNest · SQLite → PostgreSQL ===\n');
  console.log('  Source : ' + SOURCE_FILE);
  console.log('  Target : ' + (process.env.DATABASE_URL ? '(DATABASE_URL)' : (process.env.PGHOST || 'localhost')));
  console.log('  Mode   : ' + (dryRun ? 'dry run (no changes)' : truncate ? 'replace target data' : 'copy into empty target') + '\n');

  const db = openSource();
  const have = sourceTables(db);
  const client = new Client(pgConfig());

  try {
    await client.connect();
  } catch (err) {
    throw new Error('Could not connect to PostgreSQL: ' + err.message);
  }

  try {
    // 1. Make sure the schema exists (same file the app runs on boot).
    if (!dryRun) {
      const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.postgres.sql'), 'utf8');
      await client.query(schema);
    }

    // 2. Refuse to mix with existing data unless explicitly told to replace it.
    if (!dryRun) {
      const nonEmpty = [];
      for (const table of TABLES) {
        if ((await countRows(client, table)) > 0) nonEmpty.push(table);
      }
      if (nonEmpty.length) {
        if (!truncate) {
          throw new Error(
            'Target database already has data in: ' + nonEmpty.join(', ') + '.\n' +
            '  Re-run with --truncate to replace it (all data in those tables will be deleted).'
          );
        }
        console.log('  Clearing target tables...');
        await client.query(`TRUNCATE ${TABLES.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
      }
    }

    // 3. Copy table by table, only the columns both sides know about.
    const report = [];
    for (const table of TABLES) {
      if (!have.has(table)) {
        console.log(`  ${table.padEnd(20)} skipped (not in SQLite)`);
        continue;
      }
      const srcCols = sourceColumns(db, table);
      const dstCols = dryRun
        ? srcCols
        : await targetColumns(client, table);
      const dstSet = new Set(dstCols);
      const cols = srcCols.filter((c) => dstSet.has(c));

      if (!cols.length) {
        console.log(`  ${table.padEnd(20)} skipped (no shared columns)`);
        continue;
      }

      const result = await copyTable(client, db, table, cols, dryRun);
      report.push(result);
      console.log(`  ${table.padEnd(20)} ${String(result.copied).padStart(5)} rows`);
    }

    if (!dryRun) {
      await resetSequences(client);

      // 4. Verify row counts match.
      console.log('\n  Verifying counts...');
      let mismatch = 0;
      for (const { table, copied } of report) {
        const actual = await countRows(client, table);
        const ok = actual === copied;
        if (!ok) mismatch++;
        console.log(`  ${table.padEnd(20)} ${ok ? '✓' : '✗'} ${actual}/${copied}`);
      }
      if (mismatch) throw new Error('Row count mismatch — migration incomplete.');
    }

    // 5. Show what restaurants are now in the cloud database.
    if (!dryRun) {
      const tenants = await client.query('SELECT id, name, slug FROM tenants ORDER BY id');
      console.log('\n  Restaurants in PostgreSQL:');
      tenants.rows.forEach((t) => console.log(`    #${t.id}  ${t.name}  (${t.slug})`));
      const tables = await client.query('SELECT COUNT(*)::int AS c FROM tables');
      console.log(`  Tables / QR codes: ${tables.rows[0].c}`);
    }

    console.log('\n✅ Migration complete. Same logins, same QR tokens.\n');
  } finally {
    await client.end().catch(() => {});
    db.close();
  }
}

main().catch((err) => {
  console.error('\n❌ ' + err.message + '\n');
  process.exit(1);
});
