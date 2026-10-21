-- TableNest schema (multi-tenant restaurant QR ordering)
-- All business tables carry tenant_id so one DB can host many restaurants.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  slug          TEXT    NOT NULL UNIQUE,
  phone         TEXT,
  address       TEXT,
  currency      TEXT    NOT NULL DEFAULT '₹',
  gst_percent   REAL    NOT NULL DEFAULT 0,
  country_code  TEXT    NOT NULL DEFAULT '+91',
  notify_channels TEXT  NOT NULL DEFAULT 'push',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('owner','kitchen','cashier')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS menu_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_categories_tenant ON menu_categories(tenant_id);

CREATE TABLE IF NOT EXISTS menu_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id   INTEGER REFERENCES menu_categories(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  description   TEXT,
  price         REAL    NOT NULL DEFAULT 0,
  image_url     TEXT,
  is_veg        INTEGER NOT NULL DEFAULT 1,
  is_available  INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_tenant ON menu_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_items_category ON menu_items(category_id);

CREATE TABLE IF NOT EXISTS tables (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  seats         INTEGER NOT NULL DEFAULT 4,
  qr_token      TEXT    NOT NULL UNIQUE,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tables_tenant ON tables(tenant_id);

-- Device-level push subscriptions. A phone that opens the menu registers a
-- device_id (kept in localStorage) + its web-push subscription here.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id     TEXT    NOT NULL,
  endpoint      TEXT    NOT NULL UNIQUE,
  subscription  TEXT    NOT NULL, -- JSON blob (keys + endpoint)
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_tenant_device ON push_subscriptions(tenant_id, device_id);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  table_id        INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  order_no        INTEGER NOT NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  notify_optin    INTEGER NOT NULL DEFAULT 0,
  device_id       TEXT,
  status          TEXT    NOT NULL DEFAULT 'placed'
                    CHECK (status IN ('placed','accepted','preparing','ready','served','paid','cancelled')),
  item_count      INTEGER NOT NULL DEFAULT 0,
  subtotal        REAL    NOT NULL DEFAULT 0,
  gst_amount      REAL    NOT NULL DEFAULT 0,
  total           REAL    NOT NULL DEFAULT 0,
  payment_status  TEXT    NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),
  payment_method  TEXT    CHECK (payment_method IN ('cash','upi','card')),
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  price         REAL    NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  is_veg        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Every notification attempt is logged, so a restaurant owner can see what was
-- sent to whom and whether it succeeded (also acts as a delivery log).
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  channel       TEXT    NOT NULL CHECK (channel IN ('push','whatsapp','sms','email')),
  provider      TEXT    NOT NULL,
  recipient     TEXT,
  body          TEXT,
  status        TEXT    NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped','pending')),
  provider_ref  TEXT,
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_order ON notifications(order_id);

-- Audit trail of status changes.
CREATE TABLE IF NOT EXISTS order_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT    NOT NULL,
  actor         TEXT,          -- user email / 'customer' / 'system'
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
