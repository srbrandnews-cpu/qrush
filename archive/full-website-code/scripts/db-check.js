'use strict';
// Shows the current columns of key tables (migration sanity check).
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/tablenest.db');
for (const t of ['tenants', 'orders', 'notifications']) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  if (!exists) { console.log(t.padEnd(14) + ' -> TABLE MISSING'); continue; }
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  console.log(t.padEnd(14) + ' -> ' + cols.join(', '));
}
db.close();
