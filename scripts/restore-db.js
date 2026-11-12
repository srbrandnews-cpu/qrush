'use strict';

/**
 * Restore a JSON backup created by `npm run backup:db`.
 *
 * Usage:
 *   npm run restore:db -- backups/tablenest-2026-...json            (merge: existing rows kept)
 *   npm run restore:db -- backups/tablenest-2026-...json --fresh    (wipe + replace everything)
 *
 * `--fresh` TRUNCATEs every table in the backup with RESTART IDENTITY, so it is
 * meant for disaster recovery into an empty/scratch database.
 *
 * Needs DATABASE_URL (or PG* vars). Use PGDATABASE to point at a scratch DB if
 * you want to inspect the backup before touching production.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Some ISPs fail to resolve Neon hostnames (ENOTFOUND). Set
// DNS_SERVERS=8.8.8.8,1.1.1.1 in .env to bypass the local resolver.
if (process.env.DNS_SERVERS) {
  const dns = require('dns');
  dns.setServers(String(process.env.DNS_SERVERS).split(',').map((s) => s.trim()).filter(Boolean));
  console.log('DNS servers:', dns.getServers().join(', '));
}

function connectionConfig() {
  const cfg = { max: 2, idleTimeoutMillis: 10000 };
  if (process.env.DATABASE_URL) cfg.connectionString = process.env.DATABASE_URL;
  else if (process.env.PGHOST) {
    cfg.host = process.env.PGHOST;
    cfg.port = process.env.PGPORT ? Number(process.env.PGPORT) : 5432;
    cfg.user = process.env.PGUSER;
    cfg.password = process.env.PGPASSWORD;
    cfg.database = process.env.PGDATABASE;
  } else {
    console.error('\nDATABASE_URL set nahi hai. Render -> Environment se copy karke .env me daalo.\n');
    process.exit(1);
  }
  if (process.env.PGSSL === 'no-verify') cfg.ssl = { rejectUnauthorized: false };
  else if (process.env.PGSSL === 'false') cfg.ssl = false;
  return cfg;
}

/** JSON.stringify() turns Buffers into {type:'Buffer',data:[…]} — undo that. */
function toParam(v) {
  if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
    return Buffer.from(v.data);
  }
  return v;
}

function sortParentsFirst(tables, edges) {
  const deps = new Map(tables.map((t) => [t, new Set()])); // table -> parent tables
  const dependents = new Map(tables.map((t) => [t, new Set()])); // table -> child tables
  for (const [child, parent] of edges) {
    if (!deps.has(child) || !deps.has(parent) || child === parent) continue;
    deps.get(child).add(parent);
    dependents.get(parent).add(child);
  }

  const order = [];
  const ready = tables.filter((t) => deps.get(t).size === 0).sort();
  while (ready.length) {
    const t = ready.shift();
    order.push(t);
    for (const child of dependents.get(t)) {
      deps.get(child).delete(t);
      if (deps.get(child).size === 0) ready.push(child);
    }
  }
  // Cyclic FKs (rare) — append the rest alphabetically.
  for (const t of tables.slice().sort()) if (!order.includes(t)) order.push(t);
  return order;
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg || fileArg.startsWith('--')) {
    console.error('Usage: npm run restore:db -- <backup.json> [--fresh]');
    process.exit(1);
  }
  const file = path.resolve(fileArg);
  if (!fs.existsSync(file)) {
    console.error('Backup file nahi mili:', file);
    process.exit(1);
  }
  const fresh = process.argv.includes('--fresh');
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!dump.tables) throw new Error('Yeh file backup-db.js ka backup nahi lagti.');

  const pool = new Pool(connectionConfig());
  const client = await pool.connect();

  try {
    const dbTables = new Set(
      (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map((r) => r.tablename)
    );

    const available = Object.keys(dump.tables).filter((t) => {
      if (!dbTables.has(t)) console.log('  skip (table missing):', t);
      return dbTables.has(t);
    });

    // Foreign keys -> parent/child edges inside `available`.
    const fk = await client.query(`
      SELECT tc.table_name AS child, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    `);
    const order = sortParentsFirst(
      available,
      fk.rows.map((r) => [r.child, r.parent])
    );

    await client.query('BEGIN');

    if (fresh) {
      const list = available.map((t) => `"${t}"`).join(', ');
      console.log('Wiping', available.length, 'tables (RESTART IDENTITY)…');
      if (list) await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }

    let inserted = 0;
    for (const table of order) {
      const rows = dump.tables[table] || [];
      if (!rows.length) continue;
      const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
      const colList = cols.map((c) => `"${c}"`).join(', ');

      for (const row of rows) {
        const vals = cols.map((c) => toParam(row[c] === undefined ? null : row[c]));
        const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
        await client.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          vals
        );
        inserted++;
      }
      console.log('  ' + table.padEnd(28), rows.length + ' rows');
    }

    // Realign identity/serial sequences so new INSERTs don't collide.
    for (const table of order) {
      if (!(dump.tables[table] || []).some((r) => 'id' in r)) continue;
      const seq = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [table]);
      if (seq.rows[0] && seq.rows[0].seq) {
        await client.query(
          `SELECT setval($1, GREATEST(COALESCE((SELECT MAX(id) FROM "${table}"), 1), 1), true)`,
          [seq.rows[0].seq]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`\n✔ Restore complete — ${inserted} rows inserted${fresh ? ' (fresh replace)' : ' (merge)'}.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nRestore failed:', err.message);
  process.exit(1);
});
