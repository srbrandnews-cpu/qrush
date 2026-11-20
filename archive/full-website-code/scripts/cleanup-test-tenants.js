'use strict';

/**
 * Removes leftover test/demo tenants that are not real restaurants.
 * Useful after running the automated test suites.
 *
 * Run:  node scripts/cleanup-test-tenants.js
 */

const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/tablenest.db');
db.exec('PRAGMA foreign_keys = ON');

// Slugs that belong to automated tests, not real restaurants.
const TEST_SLUG_PATTERNS = ['csv-test-diner-%', 'tablenest-test-%'];

const rows = db.prepare('SELECT id, name, slug FROM tenants').all();
let removed = 0;

for (const t of rows) {
  const isTest = TEST_SLUG_PATTERNS.some((p) => {
    const re = new RegExp('^' + p.replace(/%/g, '.*') + '$');
    return re.test(t.slug);
  });
  if (!isTest) continue;

  db.prepare('DELETE FROM tenants WHERE id = ?').run(t.id);
  db.prepare('DELETE FROM users WHERE tenant_id = ?').run(t.id);
  console.log('  removed: ' + t.name + ' (' + t.slug + ')');
  removed++;
}

console.log('\nRemaining restaurants:');
for (const t of db.prepare('SELECT name, slug FROM tenants ORDER BY id').all()) {
  console.log('  • ' + t.name + '  (' + t.slug + ')');
}
console.log('\n' + removed + ' test tenant(s) removed.');
db.close();
