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

const { addColumn, tableExists, run, exec, query, dialect } = require('../config/db');

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
  {
    // v2.5 — free QR ordering: the owner lists a few orderable items, the
    // customer scans the QR and the order lands on the owner's kitchen screen.
    name: '008-free-qr-ordering',
    async up() {
      await addColumn('free_qr_menus', 'ordering_enabled', 'INTEGER NOT NULL DEFAULT 1');

      if (!(await tableExists('free_qr_items'))) {
        await exec(`
          CREATE TABLE IF NOT EXISTS free_qr_items (
            id           ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            free_qr_id   INTEGER NOT NULL,
            name         TEXT    NOT NULL,
            price        ${dialect() === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'} NOT NULL DEFAULT 0,
            category     TEXT,
            is_available INTEGER NOT NULL DEFAULT 1,
            sort_order   INTEGER NOT NULL DEFAULT 0
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_freeqr_items ON free_qr_items(free_qr_id)');
      }

      if (!(await tableExists('free_qr_orders'))) {
        const created = dialect() === 'postgres'
          ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`
          : `datetime('now')`;
        await exec(`
          CREATE TABLE IF NOT EXISTS free_qr_orders (
            id             ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            free_qr_id     INTEGER NOT NULL,
            order_no       INTEGER NOT NULL,
            public_token   TEXT    NOT NULL UNIQUE,
            table_label    TEXT,
            customer_name  TEXT,
            customer_phone TEXT,
            note           TEXT,
            items_json     TEXT    NOT NULL,
            total          ${dialect() === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'} NOT NULL DEFAULT 0,
            status         TEXT    NOT NULL DEFAULT 'new',
            created_at     TEXT    NOT NULL DEFAULT (${created}),
            updated_at     TEXT    NOT NULL DEFAULT (${created})
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_freeqr_orders ON free_qr_orders(free_qr_id, status)');
        await exec('CREATE INDEX IF NOT EXISTS idx_freeqr_orders_created ON free_qr_orders(free_qr_id, created_at)');
      }
    },
  },
  {
    // v2.6 — Phase 2 foundations: profile/plan prep + analytics (additive, no payments).
    name: '009-phase2-foundations',
    async up() {
      // ---- Free QR menus: profile fields + plan prep (no charging, no locking) ----
      await addColumn('free_qr_menus', 'address', 'TEXT');
      await addColumn('free_qr_menus', 'description', 'TEXT');
      await addColumn('free_qr_menus', 'opening_hours', 'TEXT');
      await addColumn('free_qr_menus', 'closing_hours', 'TEXT');
      await addColumn('free_qr_menus', 'plan', "TEXT NOT NULL DEFAULT 'free'");
      await addColumn('free_qr_menus', 'plan_status', "TEXT NOT NULL DEFAULT 'active'");
      await addColumn('free_qr_menus', 'plan_started_at', 'TEXT');
      await addColumn('free_qr_menus', 'plan_expires_at', 'TEXT');
      await addColumn('free_qr_menus', 'updated_at', 'TEXT');

      // ---- Tenants (SaaS track): profile fields + plan prep ----
      await addColumn('tenants', 'description', 'TEXT');
      await addColumn('tenants', 'opening_hours', 'TEXT');
      await addColumn('tenants', 'closing_hours', 'TEXT');
      await addColumn('tenants', 'whatsapp', 'TEXT');
      await addColumn('tenants', 'instagram', 'TEXT');
      await addColumn('tenants', 'facebook', 'TEXT');
      await addColumn('tenants', 'website', 'TEXT');
      await addColumn('tenants', 'plan', "TEXT NOT NULL DEFAULT 'free'");
      await addColumn('tenants', 'plan_status', "TEXT NOT NULL DEFAULT 'active'");
      await addColumn('tenants', 'plan_started_at', 'TEXT');
      await addColumn('tenants', 'plan_expires_at', 'TEXT');

      // ---- Analytics: date-range indexes + tenant menu view/scan events ----
      await exec('CREATE INDEX IF NOT EXISTS idx_freeqr_events_created ON free_qr_events(free_qr_id, created_at)');
      await exec('CREATE INDEX IF NOT EXISTS idx_freeqr_orders_created_only ON free_qr_orders(free_qr_id, created_at)');

      if (!(await tableExists('tenant_menu_events'))) {
        const created = dialect() === 'postgres'
          ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`
          : `datetime('now')`;
        await exec(`
          CREATE TABLE IF NOT EXISTS tenant_menu_events (
            id         ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            table_id   INTEGER REFERENCES tables(id) ON DELETE SET NULL,
            kind       TEXT    NOT NULL,
            visitor    TEXT,
            created_at TEXT    NOT NULL DEFAULT (${created})
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_tenant_menu_events ON tenant_menu_events(tenant_id, kind, created_at)');
        await exec('CREATE INDEX IF NOT EXISTS idx_tenant_menu_events_created ON tenant_menu_events(tenant_id, created_at)');
      }
    },
  },
  {
    // v3.0 — Phase 3 monetization: subscriptions, payments, ads, settings (additive, no payments gateway).
    name: '010-phase3-monetization',
    async up() {
      const created = dialect() === 'postgres'
        ? `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`
        : `datetime('now')`;

      // ---- Admin settings (configurable WhatsApp number, plan prices, features, grace period) ----
      if (!(await tableExists('admin_settings'))) {
        await exec(`
          CREATE TABLE IF NOT EXISTS admin_settings (
            key        TEXT    NOT NULL PRIMARY KEY,
            value      TEXT,
            updated_at TEXT    NOT NULL DEFAULT (${created}),
            updated_by TEXT
          )
        `);
      }

      // Seed default settings if not present
      const defaultSettings = [
        ['whatsapp_number', ''],
        ['whatsapp_support_message', 'Hello QRUSH Team, I want to upgrade my restaurant account.'],
        ['default_subscription_duration_days', '30'],
        ['grace_period_days', '7'],
        ['plan_free_price', '0'],
        ['plan_starter_price', '149'],
        ['plan_business_price', '299'],
        ['plan_free_features', 'Basic digital menu, Restaurant profile, QR code generation and download, Basic menu management, Public menu page'],
        ['plan_starter_features', 'Everything in Free, Enhanced analytics, Additional menu customization'],
        ['plan_business_features', 'Everything in Starter, Advanced analytics, Priority WhatsApp support'],
        // Ads start switched OFF: platform owner enables them from
        // Super Admin -> Settings once there are enough restaurants.
        ['ad_enabled', '0'],
      ];
      for (const [key, value] of defaultSettings) {
        if (dialect() === 'postgres') {
          await run(
            'INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
            [key, value],
            { returning: false }
          );
        } else {
          await run('INSERT OR IGNORE INTO admin_settings (key, value) VALUES (?, ?)', [key, value]);
        }
      }

      // ---- Subscription payments (manual payment records) ----
      if (!(await tableExists('subscription_payments'))) {
        await exec(`
          CREATE TABLE IF NOT EXISTS subscription_payments (
            id              ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            plan            TEXT    NOT NULL,
            amount          REAL    NOT NULL DEFAULT 0,
            payment_method  TEXT    NOT NULL DEFAULT 'other',
            payment_ref     TEXT,
            status          TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','confirmed','rejected','refunded')),
            activated_by    TEXT,
            activated_at    TEXT,
            expires_at      TEXT,
            notes           TEXT,
            created_at      TEXT    NOT NULL DEFAULT (${created})
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_sub_payments_tenant ON subscription_payments(tenant_id, status)');
        await exec('CREATE INDEX IF NOT EXISTS idx_sub_payments_status ON subscription_payments(status, created_at)');
      }

      // ---- Subscription history (audit log) ----
      if (!(await tableExists('subscription_history'))) {
        await exec(`
          CREATE TABLE IF NOT EXISTS subscription_history (
            id              ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            previous_plan   TEXT,
            new_plan        TEXT    NOT NULL,
            previous_status TEXT,
            new_status      TEXT    NOT NULL,
            amount          REAL,
            payment_method  TEXT,
            payment_ref     TEXT,
            admin_email     TEXT,
            notes           TEXT,
            created_at      TEXT    NOT NULL DEFAULT (${created})
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_sub_history_tenant ON subscription_history(tenant_id, created_at)');
      }

      // ---- Advertisements ----
      if (!(await tableExists('advertisements'))) {
        await exec(`
          CREATE TABLE IF NOT EXISTS advertisements (
            id            ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            title         TEXT    NOT NULL,
            image_url     TEXT    NOT NULL,
            destination_url TEXT,
            placement     TEXT    NOT NULL DEFAULT 'public_menu',
            start_date    TEXT,
            end_date      TEXT,
            is_active     INTEGER NOT NULL DEFAULT 1,
            created_by    TEXT,
            created_at    TEXT    NOT NULL DEFAULT (${created}),
            updated_at    TEXT    NOT NULL DEFAULT (${created})
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_ads_placement ON advertisements(placement, is_active)');
      }

      // ---- Ad events (impressions and clicks, deduped) ----
      if (!(await tableExists('ad_events'))) {
        await exec(`
          CREATE TABLE IF NOT EXISTS ad_events (
            id            ${dialect() === 'postgres' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            ad_id         INTEGER NOT NULL REFERENCES advertisements(id) ON DELETE CASCADE,
            tenant_id     INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
            kind          TEXT    NOT NULL CHECK (kind IN ('impression','click')),
            visitor       TEXT,
            created_at    TEXT    NOT NULL DEFAULT (${created})
          )
        `);
        await exec('CREATE INDEX IF NOT EXISTS idx_ad_events_ad ON ad_events(ad_id, kind, created_at)');
        await exec('CREATE INDEX IF NOT EXISTS idx_ad_events_created ON ad_events(created_at)');
      }

      // ---- Add plan_price and plan_features to free_qr_menus (if not present) ----
      // Already has plan/plan_status from migration 009; no new columns needed.
    },
  },
  {
    // v3.1 — Phase 3 Free QR monetization: extend subscription_payments for free_qr_menus.
    name: '011-phase3-freeqr-billing',
    async up() {
      await addColumn('subscription_payments', 'free_qr_id', 'INTEGER REFERENCES free_qr_menus(id) ON DELETE CASCADE');
      await addColumn('subscription_payments', 'payment_type', "TEXT NOT NULL DEFAULT 'tenant'");
      await addColumn('subscription_history', 'free_qr_id', 'INTEGER REFERENCES free_qr_menus(id) ON DELETE CASCADE');
      await addColumn('subscription_history', 'payment_type', "TEXT NOT NULL DEFAULT 'tenant'");
      // tenant_id nullable part is handled by migration 012.
    },
  },
  {
    // v3.2 — Free QR payments have no tenant_id, so tenant_id must allow NULL.
    name: '012-phase3-nullable-tenant',
    async up() {
      if (dialect() === 'postgres') {
        await exec('ALTER TABLE subscription_payments ALTER COLUMN tenant_id DROP NOT NULL').catch(() => {});
        await exec('ALTER TABLE subscription_history ALTER COLUMN tenant_id DROP NOT NULL').catch(() => {});
        return;
      }

      // ---- SQLite: rebuild subscription_payments without NOT NULL on tenant_id ----
      const payCols = await query('PRAGMA table_info(subscription_payments)');
      const payTenant = payCols.find((c) => c.name === 'tenant_id');
      if (payTenant && payTenant.notnull !== 0) {
        await exec(`
          CREATE TABLE IF NOT EXISTS subscription_payments_new (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
            plan            TEXT    NOT NULL,
            amount          REAL    NOT NULL DEFAULT 0,
            payment_method  TEXT    NOT NULL DEFAULT 'other',
            payment_ref     TEXT,
            status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','refunded')),
            activated_by    TEXT,
            activated_at    TEXT,
            expires_at      TEXT,
            notes           TEXT,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            free_qr_id      INTEGER REFERENCES free_qr_menus(id) ON DELETE CASCADE,
            payment_type    TEXT    NOT NULL DEFAULT 'tenant'
          );
          INSERT OR IGNORE INTO subscription_payments_new
            (id, tenant_id, plan, amount, payment_method, payment_ref, status, activated_by, activated_at, expires_at, notes, created_at, free_qr_id, payment_type)
          SELECT id, tenant_id, plan, amount, payment_method, payment_ref, status, activated_by, activated_at, expires_at, notes, created_at, free_qr_id, payment_type
          FROM subscription_payments;
          DROP TABLE subscription_payments;
          ALTER TABLE subscription_payments_new RENAME TO subscription_payments;
          CREATE INDEX IF NOT EXISTS idx_sub_payments_tenant ON subscription_payments(tenant_id, status);
          CREATE INDEX IF NOT EXISTS idx_sub_payments_status ON subscription_payments(status, created_at);
        `);
      }

      // ---- SQLite: rebuild subscription_history the same way ----
      const histCols = await query('PRAGMA table_info(subscription_history)');
      const histTenant = histCols.find((c) => c.name === 'tenant_id');
      if (histTenant && histTenant.notnull !== 0) {
        await exec(`
          CREATE TABLE IF NOT EXISTS subscription_history_new (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
            previous_plan   TEXT,
            new_plan        TEXT    NOT NULL,
            previous_status TEXT,
            new_status      TEXT    NOT NULL,
            amount          REAL,
            payment_method  TEXT,
            payment_ref     TEXT,
            admin_email     TEXT,
            notes           TEXT,
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            free_qr_id      INTEGER REFERENCES free_qr_menus(id) ON DELETE CASCADE,
            payment_type    TEXT    NOT NULL DEFAULT 'tenant'
          );
          INSERT OR IGNORE INTO subscription_history_new
            (id, tenant_id, previous_plan, new_plan, previous_status, new_status, amount, payment_method, payment_ref, admin_email, notes, created_at, free_qr_id, payment_type)
          SELECT id, tenant_id, previous_plan, new_plan, previous_status, new_status, amount, payment_method, payment_ref, admin_email, notes, created_at, free_qr_id, payment_type
          FROM subscription_history;
          DROP TABLE subscription_history;
          ALTER TABLE subscription_history_new RENAME TO subscription_history;
          CREATE INDEX IF NOT EXISTS idx_sub_history_tenant ON subscription_history(tenant_id, created_at);
        `);
      }
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
