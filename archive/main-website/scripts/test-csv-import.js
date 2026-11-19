'use strict';

/**
 * Tests the bulk CSV menu import end-to-end:
 *   signup a throwaway restaurant -> import a CSV -> verify categories/items
 *   -> re-import (should update, not duplicate) -> clean up.
 *
 * Run:  node scripts/test-csv-import.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const CSV = `Category,Item Name,Description,Price,Veg
Starters,"Paneer Tikka, grilled",Char-grilled cottage cheese,260,Veg
Starters,Chicken Tikka,Smoky tandoori skewers,320,Non-veg
Main Course,Paneer Butter Masala,"Rich tomato gravy, cashew",280,Veg
Main Course,Butter Chicken,Classic murgh makhani,360,Non-veg
Beverages,Masala Chai,Spiced tea,40,Veg
Beverages,Filter Coffee,,30,Non-veg`;

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  console.log('\n=== CSV import test ===\n');
  const stamp = Date.now();
  const email = `csvtest${stamp}@tablenest.test`;
  const slug = `csv-test-diner-${stamp}`;

  // Always clean up the throwaway restaurant, even if an assertion fails.
  const cleanup = () => {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('data/tablenest.db');
      db.exec('PRAGMA foreign_keys = ON');
      const row = db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
      if (row) {
        db.prepare('DELETE FROM tenants WHERE id = ?').run(row.id);
        db.prepare('DELETE FROM users WHERE email = ?').run(email);
        console.log('  ✓ throwaway tenant cleaned up');
      }
      db.close();
    } catch (err) {
      console.log('  (cleanup skipped: ' + err.message + ')');
    }
  };

  try {
    await runTest(stamp, email, slug);
  } catch (err) {
    cleanup();
    throw err;
  }
  cleanup();
  console.log('\n✅ CSV import works perfectly.\n');
}

async function runTest(stamp, email, slug) {
  // 1. Create a throwaway restaurant.
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { restaurant: 'CSV Test Diner ' + stamp, name: 'CSV Tester', email, password: 'pass1234' },
  });
  assert(signup.status === 201 && signup.data.token, 'throwaway restaurant created (multi-tenant signup works)');
  const token = signup.data.token;

  // 2. Import the CSV.
  const imp = await api('/api/menu/import', { method: 'POST', token, body: { csv: CSV, mode: 'append' } });
  assert(imp.status === 200 && imp.data.ok, 'CSV imported successfully');
  assert(imp.data.itemsCreated === 6, `6 items created (got ${imp.data.itemsCreated})`);
  assert(imp.data.categoriesCreated === 3, `3 categories created (got ${imp.data.categoriesCreated})`);
  assert(!imp.data.errors || imp.data.errors.length === 0, 'no row errors');

  // 3. Menu reflects the import, with correct veg flags and quoted fields.
  const menu = await api('/api/menu', { token });
  const cats = menu.data.categories.map((c) => c.name).sort();
  assert(JSON.stringify(cats) === JSON.stringify(['Beverages', 'Main Course', 'Starters']),
    'categories correct: ' + cats.join(', '));
  const all = menu.data.categories.flatMap((c) => c.items);
  assert(all.length === 6, '6 items in menu');
  // Note: the item name itself contains a comma inside quotes, which is the
  // whole point of that row — it must survive parsing intact.
  const tikka = all.find((i) => i.name === 'Paneer Tikka, grilled');
  assert(!!tikka, 'quoted comma inside item name parsed intact');
  assert(tikka.description === 'Char-grilled cottage cheese', 'quoted description with comma parsed correctly');
  assert(tikka.price === 260, 'price parsed as number');
  const chicken = all.find((i) => i.name === 'Chicken Tikka');
  assert(chicken.is_veg === 0, 'non-veg item flagged correctly');
  const chai = all.find((i) => i.name === 'Masala Chai');
  assert(chai.is_veg === 1, 'veg item flagged correctly');

  // 4. Re-import should UPDATE, not duplicate.
  const imp2 = await api('/api/menu/import', { method: 'POST', token, body: { csv: CSV, mode: 'append' } });
  assert(imp2.data.itemsCreated === 0, 're-import creates 0 new items');
  assert(imp2.data.itemsUpdated === 6, `re-import updates 6 items (got ${imp2.data.itemsUpdated})`);
  assert(imp2.data.categoriesCreated === 0, 're-import creates 0 new categories');
  const menu2 = await api('/api/menu', { token });
  assert(menu2.data.categories.flatMap((c) => c.items).length === 6, 'still exactly 6 items (no duplicates)');

  // 5. Bad rows are reported but do not abort the import.
  const messy = `Category,Item Name,Price,Veg
Starters,Good Item,100,Veg
Starters,,150,Veg
Starters,Bad Price,not-a-number,Veg
Starters,Another Good,200,Non-veg`;
  const imp3 = await api('/api/menu/import', { method: 'POST', token, body: { csv: messy, mode: 'append' } });
  assert(imp3.data.itemsCreated === 2, `2 valid rows imported (got ${imp3.data.itemsCreated})`);
  assert(imp3.data.errors.length === 2, `2 bad rows reported (got ${imp3.data.errors.length})`);

  // 5b. Real-world price formats must be accepted: ₹260 and "1,200".
  const formats = `Category,Item Name,Price,Veg
Prices,Plain,100,Veg
Prices,With Rupee Sign,₹260,Veg
Prices,With Thousands,"1,200",Non-veg`;
  const imp4 = await api('/api/menu/import', { method: 'POST', token, body: { csv: formats, mode: 'append' } });
  assert(imp4.data.itemsCreated === 3, `3 price formats accepted (got ${imp4.data.itemsCreated})`);
  assert(!imp4.data.errors || imp4.data.errors.length === 0, 'no errors for valid price formats');
  const menu3 = await api('/api/menu', { token });
  const priced = menu3.data.categories.flatMap((c) => c.items);
  assert(priced.find((i) => i.name === 'With Rupee Sign').price === 260, '"₹260" -> 260');
  assert(priced.find((i) => i.name === 'With Thousands').price === 1200, '"1,200" -> 1200');
  assert(priced.every((i) => i.price !== 0), 'no item silently saved with price 0');

  // 5c. A garbage price must NOT become a ₹0 item.
  const zeroCheck = priced.find((i) => i.name === 'Bad Price');
  assert(!zeroCheck, 'invalid price row was rejected, not saved as ₹0');

  // 6. Template downloads and parses (auth required, like every admin route).
  const tpl = await fetch(BASE + '/api/menu/template.csv', {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert(tpl.status === 200, 'template CSV downloads');
  const tplText = await tpl.text();
  assert(tplText.includes('Category,Item Name'), 'template has expected headers');
  // The BOM must survive on the wire (Response.text() strips it, so check bytes).
  const bytes = Buffer.from(await (await fetch(BASE + '/api/menu/template.csv', {
    headers: { Authorization: 'Bearer ' + token },
  })).arrayBuffer());
  assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    'template has UTF-8 BOM (so Excel reads ₹ correctly)');

  // (cleanup runs in main(), even if an assertion above failed)
}

main().catch((err) => {
  console.error('\n' + err.message + '\n');
  process.exit(1);
});
