'use strict';

/**
 * Database layer with two interchangeable drivers:
 *
 *   DB_CLIENT=sqlite    (default — zero setup, great for local/dev & small installs)
 *   DB_CLIENT=postgres  (production — connection pooling, real concurrency)
 *
 * Both expose the SAME async interface, so routes/services never care which one
 * is active. Every call site uses `await`, which is why the interface is async
 * even for the synchronous node:sqlite backend.
 *
 *   await query(sql, params)   -> array of rows
 *   await get(sql, params)     -> first row or undefined
 *   await run(sql, params)     -> { changes, lastInsertRowid }
 *   await exec(sql)            -> run multi-statement DDL
 *   await transaction(fn)      -> run fn in a transaction (fn may be async)
 *
 * NOTE: SQL is written with `?` placeholders everywhere. For Postgres these are
 * rewritten to $1..$N automatically, and INSERTs get `RETURNING id` appended so
 * `lastInsertRowid` behaves identically on both drivers.
 */

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const DIALECT = (process.env.DB_CLIENT || 'sqlite').toLowerCase();
const als = new AsyncLocalStorage();

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

/* ======================================================================== */
/*  SQLite driver (node:sqlite)                                              */
/* ======================================================================== */

let sqlite = null;

function initSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.DB_FILE || path.join(DB_DIR, 'tablenest.db');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

// SQLite is a single synchronous connection. Because transaction(fn) now awaits
// an async fn, we serialise transactions so two of them can never interleave.
let sqliteTxQueue = Promise.resolve();

/* ======================================================================== */
/*  Postgres driver (pg)                                                    */
/* ======================================================================== */

let pool = null;

function initPostgres() {
  const { Pool } = require('pg');
  const pgTypes = require('pg-types');

  // Postgres returns int8 (bigint) as a string to avoid precision loss, but
  // SQLite returns a number. Our COUNT(*) values are far below
  // Number.MAX_SAFE_INTEGER, so parse them as numbers to keep both drivers
  // returning an identical API shape.
  pgTypes.setTypeParser(20, (val) => parseInt(val, 10));

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: process.env.PGPOOL_MAX ? Number(process.env.PGPOOL_MAX) : 10,
    idleTimeoutMillis: 30000,
  });
  return pool;
}

/** Rewrite `?` placeholders into Postgres $1..$N. */
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** The pooled client bound to the current transaction, if any. */
function txClient() {
  const store = als.getStore();
  return store && store.client ? store.client : null;
}

/** INSERTs auto-gain `RETURNING id` so run() can report lastInsertRowid. */
function withReturning(sql) {
  const trimmed = sql.replace(/;\s*$/, '');
  if (/^\s*insert\s/i.test(trimmed) && !/\breturning\b/i.test(trimmed)) {
    return trimmed + ' RETURNING id';
  }
  return trimmed;
}

/* ======================================================================== */
/*  Shared public API (async)                                               */
/* ======================================================================== */

function plain(row) {
  return row == null ? row : Object.assign({}, row);
}

/** Initialise the chosen driver + make sure schema exists. Called by server. */
function initDriver() {
  if (DIALECT === 'postgres') {
    initPostgres();
  } else {
    sqlite = initSqlite();
  }
}
initDriver();

/** Multi-statement DDL. */
async function exec(sql) {
  if (DIALECT === 'postgres') {
    await pool.query(sql);
  } else {
    sqlite.exec(sql);
  }
}

/** All matching rows. */
async function query(sql, params = []) {
  if (DIALECT === 'postgres') {
    const client = txClient();
    const res = client
      ? await client.query(toPgPlaceholders(sql), params)
      : await pool.query(toPgPlaceholders(sql), params);
    return res.rows.map(plain);
  }
  return sqlite.prepare(sql).all(...params).map(plain);
}

/** First matching row or undefined. */
async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : undefined;
}

/** INSERT/UPDATE/DELETE -> { changes, lastInsertRowid }. */
async function run(sql, params = []) {
  if (DIALECT === 'postgres') {
    const finalSql = withReturning(sql);
    const client = txClient();
    const res = client
      ? await client.query(toPgPlaceholders(finalSql), params)
      : await pool.query(toPgPlaceholders(finalSql), params);
    const row = res.rows[0];
    return {
      changes: res.rowCount,
      lastInsertRowid: row && row.id != null ? Number(row.id) : undefined,
    };
  }
  const res = sqlite.prepare(sql).run(...params);
  return { changes: res.changes, lastInsertRowid: Number(res.lastInsertRowid) };
}

/**
 * Run fn inside a transaction. fn may be async. For Postgres every query made
 * inside fn is pinned to one connection (via AsyncLocalStorage), so nested
 * query/get/run calls participate in the same transaction. Rolls back on throw.
 */
async function transaction(fn) {
  if (DIALECT === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await als.run({ client }, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  // SQLite: serialise transactions on the single connection.
  const runTx = async () => {
    sqlite.exec('BEGIN');
    try {
      const result = await fn();
      sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    }
  };
  const next = sqliteTxQueue.then(runTx, runTx);
  sqliteTxQueue = next.catch(() => {});
  return next;
}

/** Current UTC timestamp in the exact text format both schemas store. */
function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Today's UTC date (YYYY-MM-DD) for date-range filters. */
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Does a column already exist on a table? Used by the migration runner so
 * adding a column is safe to run on every boot.
 */
async function columnExists(table, column) {
  if (DIALECT === 'postgres') {
    const res = await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
      [table, column]
    );
    return res.rows.length > 0;
  }
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

/** Add a column if it isn't there yet. */
async function addColumn(table, column, definition) {
  if (await columnExists(table, column)) return false;
  await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** Does a table exist? */
async function tableExists(table) {
  if (DIALECT === 'postgres') {
    const res = await pool.query(
      'SELECT table_name FROM information_schema.tables WHERE table_name = $1',
      [table]
    );
    return res.rows.length > 0;
  }
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).all(table);
  return rows.length > 0;
}

function dialect() { return DIALECT; }

async function close() {
  if (DIALECT === 'postgres' && pool) await pool.end();
}

module.exports = {
  exec, query, get, run, transaction, utcNow, utcToday, dialect, close,
  columnExists, addColumn, tableExists,
};
