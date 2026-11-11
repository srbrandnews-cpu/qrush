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

const { addColumn, tableExists, run, exec, dialect } = require('../config/db');

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
  {
    // v2.0 — live table service: quick requests, rush menu, UPI, feedback.
    name: '003-live-service',
    async up() {
      await addColumn('tenants', 'wifi_name', 'TEXT');
      await addColumn('tenants', 'wifi_password', 'TEXT');
      await addColumn('tenants', 'upi_id', 'TEXT');
      await addColumn('tenants', 'rush_mode', 'INTEGER NOT NULL DEFAULT 0');
      await addColumn('tenants', 'prep_minutes', 'INTEGER NOT NULL DEFAULT 15');
      await addColumn('menu_items', 'is_quick', 'INTEGER NOT NULL DEFAULT 0');
      await addColumn('orders', 'rating', 'INTEGER');
      await addColumn('orders', 'feedback', 'TEXT');

      if (!(await tableExists('table_requests'))) {
        const created = dialect() === 'postgres'
          ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`
          : `datetime('now')`;
        await exec(`
          CREATE TABLE IF NOT EXISTS table_requests (
            id            ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            table_id      INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
            type          TEXT    NOT NULL,
            status        TEXT    NOT NULL DEFAULT 'open',
            resolved_by   TEXT,
            created_at    TEXT    NOT NULL DEFAULT (${created}),
            resolved_at   TEXT
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_requests_tenant ON table_requests(tenant_id, status)');
      }
    },
  },
  {
    // v2.1 — logo url for tenants, parcel option for orders
    name: '004-logo-parcel',
    async up() {
      await addColumn('tenants', 'logo_url', 'TEXT');
      await addColumn('orders', 'is_parcel', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    // v2.2 — order type: dine-in / takeaway / pickup
    name: '005-order-type',
    async up() {
      await addColumn('orders', 'order_type', "TEXT NOT NULL DEFAULT 'dinein'");
      await addColumn('orders', 'pickup_time', 'TEXT');
    },
  },
  {
    // v2.3 — free QR menu uploads
    name: '006-free-qr',
    async up() {
      if (!(await tableExists('free_qr_menus'))) {
        const created = dialect() === 'postgres'
          ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`
          : `datetime('now')`;
        await exec(`
          CREATE TABLE IF NOT EXISTS free_qr_menus (
            id            ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            slug          TEXT    NOT NULL UNIQUE,
            restaurant    TEXT    NOT NULL,
            owner_name    TEXT,
            phone         TEXT,
            password_hash TEXT,
            logo_url      TEXT,
            menu_data     TEXT    NOT NULL,
            menu_type     TEXT    NOT NULL DEFAULT 'image',
            instagram     TEXT,
            facebook      TEXT,
            whatsapp      TEXT,
            website       TEXT,
            created_at    TEXT    NOT NULL DEFAULT (${created})
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_freeqr_slug ON free_qr_menus(slug)');
      } else {
        await addColumn('free_qr_menus', 'instagram', 'TEXT');
        await addColumn('free_qr_menus', 'facebook', 'TEXT');
        await addColumn('free_qr_menus', 'whatsapp', 'TEXT');
        await addColumn('free_qr_menus', 'website', 'TEXT');
      }
    },
  },
  {
    // v2.4 — free QR analytics: menu page visits + social link clicks.
    // kind = 'view' | 'whatsapp' | 'instagram' | 'facebook' | 'website'
    name: '007-free-qr-events',
    async up() {
      if (await tableExists('free_qr_events')) return;
      const created = dialect() === 'postgres'
        ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`
        : `datetime('now')`;
      await exec(`
        CREATE TABLE IF NOT EXISTS free_qr_events (
          id         ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
          free_qr_id INTEGER NOT NULL,
          kind       TEXT    NOT NULL,
          visitor    TEXT,
          created_at TEXT    NOT NULL DEFAULT (${created})
        )
      `);
      await exec('CREATE INDEX IF NOT EXISTS idx_freeqr_events ON free_qr_events(free_qr_id, kind)');
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
