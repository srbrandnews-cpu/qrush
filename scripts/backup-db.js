'use strict';

/**
 * Full JSON backup of the production Postgres database (Neon).
 *
 * Usage:
 *   npm run backup:db
 *   npm run backup:db -- --out D:\backups\qrush.json
 *
 * Needs DATABASE_URL (Render dashboard -> your service -> Environment).
 * Writes to ./backups/tablenest-<timestamp>.json by default.
 * Restore with: npm run restore:db -- backups/<file>.json
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

  if (process.env.DATABASE_URL) {
    cfg.connectionString = process.env.DATABASE_URL;
  } else if (process.env.PGHOST) {
    cfg.host = process.env.PGHOST;
    cfg.port = process.env.PGPORT ? Number(process.env.PGPORT) : 5432;
    cfg.user = process.env.PGUSER;
    cfg.password = process.env.PGPASSWORD;
    cfg.database = process.env.PGDATABASE;
  } else {
    console.error(
      '\nDATABASE_URL set nahi hai.\n' +
        'Render dashboard -> tablenest -> Environment -> DATABASE_URL copy karke:\n' +
        '  PowerShell:  $env:DATABASE_URL="postgresql://..."\n' +
        '  ya .env file me DATABASE_URL=... daal do (file ko git me commit mat karna).\n'
    );
    process.exit(1);
  }

  if (process.env.PGSSL === 'no-verify') cfg.ssl = { rejectUnauthorized: false };
  else if (process.env.PGSSL === 'false') cfg.ssl = false;

  return cfg;
}

async function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const pool = new Pool(connectionConfig());
  const started = Date.now();

  console.log('Connecting…');
  const tablesRes = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  const tables = tablesRes.rows.map((r) => r.tablename);
  if (!tables.length) throw new Error('No tables found — galat database?');

  const dump = {
    app: 'tablenest',
    created_at: new Date().toISOString(),
    server_version: (await pool.query('SHOW server_version')).rows[0].server_version,
    tables: {},
  };

  let total = 0;
  for (const table of tables) {
    const r = await pool.query(`SELECT * FROM "${table}"`);
    dump.tables[table] = r.rows;
    total += r.rows.length;
    console.log('  ' + table.padEnd(28), r.rows.length + ' rows');
  }

  const dir = outArgIdx > -1 ? path.dirname(process.argv[outArgIdx + 1]) : (process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
  const file =
    outArgIdx > -1
      ? path.resolve(process.argv[outArgIdx + 1])
      : path.join(dir, 'tablenest-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(dump), 'utf8');

  const size = (fs.statSync(file).size / (1024 * 1024)).toFixed(2);
  console.log(`\n✔ Backup saved: ${file}`);
  console.log(`  ${tables.length} tables · ${total} rows · ${size} MB · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('  Is file ko Google Drive / pen drive par bhi copy kar lo.');

  await pool.end();
}

main().catch((err) => {
  console.error('\nBackup failed:', err.message);
  process.exit(1);
});
