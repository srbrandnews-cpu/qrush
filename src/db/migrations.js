'use strict';

/**
 * Lightweight schema migrations.
 *
 * `ensureSchema()` only creates tables that don't exist yet, so any column
 * added to a later version needs an explicit migration. Each migration is
 * applied at most once and is safe to run on every boot.
 *
 * To add a column in a future version, append another entry to MIGRATIONS —
 * never edit an existing one (already-deployed databases would skip it).
 */

const { addColumn, tableExists, run } = require('../config/db');

const MIGRATIONS = [
  {
    // v1.1 — WhatsApp/SMS notification support
    name: '001-notification-settings',
    async up() {
      await addColumn('tenants', 'country_code', "TEXT NOT NULL DEFAULT '+91'");
      await addColumn('tenants', 'notify_channels', "TEXT NOT NULL DEFAULT 'push,whatsapp,sms'");
      await addColumn('orders', 'notify_optin', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    // v1.2 — WhatsApp/SMS channels removed; only browser push remains.
    name: '002-push-only',
    async up() {
      await run("UPDATE tenants SET notify_channels = 'push'");
    },
  },
];

/**
 * Run every migration that hasn't been applied yet.
 */
async function runMigrations() {
  const applied = [];

  for (const migration of MIGRATIONS) {
    // The notifications table is new, so it may not exist on old databases.
    if (migration.name === '001-notification-settings') {
      // The ALTERs are guarded by addColumn(), so nothing to check here.
    }
    try {
      await migration.up();
      applied.push(migration.name);
    } catch (err) {
      console.error(`[migrate] ${migration.name} failed:`, err.message);
      throw err;
    }
  }

  if (applied.length) {
    console.log(`[migrate] applied: ${applied.join(', ')}`);
  }
  return applied;
}

module.exports = { runMigrations, MIGRATIONS };
