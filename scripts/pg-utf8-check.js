'use strict';
// Quick check: can we init an embedded PG cluster with UTF-8 encoding on Windows?
const fs = require('fs');
const path = require('path');
const EmbeddedPostgresModule = require('embedded-postgres');
const EmbeddedPostgres = EmbeddedPostgresModule.default || EmbeddedPostgresModule;
const { Client } = require('pg');

const DATA_DIR = path.join(__dirname, '..', 'data', 'pg-utf8-check');
const flags = process.argv.slice(2);
if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: 'postgres', password: 'postgres', port: 55440,
    persistent: false, initdbFlags: flags,
  });
  await pg.initialise();
  await pg.start();
  const c = new Client({ host: 'localhost', port: 55440, user: 'postgres', password: 'postgres', database: 'postgres' });
  await c.connect();
  const enc = await c.query('SELECT pg_encoding_to_char(encoding) AS e, datcollate FROM pg_database WHERE datname = current_database()');
  console.log('FLAGS:', JSON.stringify(flags), '=> encoding:', enc.rows[0].e, 'collate:', enc.rows[0].datcollate);
  await c.query('CREATE DATABASE enc_test ENCODING \'UTF8\' TEMPLATE template0');
  const c2 = new Client({ host: 'localhost', port: 55440, user: 'postgres', password: 'postgres', database: 'enc_test' });
  await c2.connect();
  await c2.query('CREATE TABLE t(v TEXT)');
  await c2.query('INSERT INTO t VALUES ($1)', ['₹ rupees']);
  const v = await c2.query('SELECT v FROM t');
  console.log('  rupee stored OK ->', v.rows[0].v);
  await c2.end(); await c.end(); await pg.stop();
  console.log('  SUCCESS');
})().catch(e => { console.error('  FAILED:', e.message); process.exit(1); });
