'use strict';

/**
 * Wipes all orders and prints each table's QR menu link.
 * Works with whichever database driver is configured (sqlite or postgres).
 *
 * Run:  node scripts/reset-orders.js
 */

const { run, query, dialect } = require('../src/config/db');

async function main() {
  await run('DELETE FROM orders');
  console.log(`Orders cleared (database: ${dialect()}).\n`);

  const rows = await query('SELECT name, qr_token FROM tables ORDER BY id');
  const base = process.env.BASE_URL || 'http://localhost:3000';
  console.log('Customer menu links (scan wala):');
  rows.slice(0, 6).forEach((r) => {
    console.log('  ' + r.name.padEnd(9) + '->  ' + base + '/menu?table=' + r.qr_token);
  });
  console.log('\n(Admin -> "Tables & QR" tab mein sab QR codes print kar sakte hain)');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
