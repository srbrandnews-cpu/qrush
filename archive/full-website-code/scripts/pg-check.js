'use strict';

/**
 * Boots a throwaway embedded PostgreSQL server to prove the Postgres stack
 * works on this machine (used to validate the Postgres migration).
 *
 * Run:  node scripts/pg-check.js
 */

const EmbeddedPostgresModule = require('embedded-postgres');
const EmbeddedPostgres = EmbeddedPostgresModule.default || EmbeddedPostgresModule;
const { Client } = require('pg');

async function main() {
  const dataDir = require('path').join(__dirname, '..', 'data', 'pg-check');
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: 55432,
    persistent: false,
  });

  console.log('Initialising embedded PostgreSQL...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pgcheck');
  console.log('PostgreSQL started on port 55432 ✓');

  const client = new Client({ host: 'localhost', port: 55432, user: 'postgres', password: 'postgres', database: 'pgcheck' });
  await client.connect();
  const ver = await client.query('SELECT version()');
  console.log('Connected:', ver.rows[0].version.split(',')[0]);

  // Sanity checks for the SQL features our schema relies on.
  await client.query(`
    CREATE TABLE t (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL DEFAULT 0,
      flag INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')),
      CHECK (flag IN (0,1))
    );
  `);
  const ins = await client.query('INSERT INTO t (name, price) VALUES ($1, $2) RETURNING id', ['Paneer', 260]);
  console.log('SERIAL + RETURNING id ->', ins.rows[0].id, '✓');

  const conf = await client.query(
    "INSERT INTO t (name, price) VALUES ($1, $2) ON CONFLICT DO NOTHING", ['x', 1]
  );
  console.log('ON CONFLICT supported ✓');

  const ts = await client.query('SELECT created_at FROM t WHERE id = $1', [ins.rows[0].id]);
  console.log('UTC text timestamp ->', ts.rows[0].created_at, '✓');

  const sub = await client.query("SELECT substr('2026-10-21 07:12:00', 1, 10) AS d");
  console.log('substr() works ->', sub.rows[0].d, '✓');

  await client.end();
  await pg.stop();
  console.log('\n✅ Embedded PostgreSQL fully operational on this machine.\n');
}

main().catch((err) => {
  console.error('\n❌ Embedded PostgreSQL failed:', err.message, '\n');
  process.exit(1);
});
