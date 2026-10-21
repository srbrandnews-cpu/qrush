'use strict';

/**
 * Seeds a fully-workable demo restaurant so you can try the whole flow in
 * seconds: demo menu, 8 tables with QR codes, and three login accounts.
 *
 * Run:  npm run seed
 *
 * Logins (password for all: pass1234)
 *   owner@demo.com    -> admin dashboard
 *   kitchen@demo.com  -> kitchen display
 *   cashier@demo.com  -> cash counter
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { get, run, transaction, dialect } = require('../config/db');
const { ensureSchema } = require('./init');
const { runMigrations } = require('./migrations');

const PASSWORD = 'pass1234';

const DEMO_MENU = [
  {
    name: 'Starters',
    items: [
      { name: 'Paneer Tikka', description: 'Char-grilled cottage cheese with mint chutney', price: 260, is_veg: 1 },
      { name: 'Chicken Tikka', description: 'Smoky tandoori chicken skewers', price: 320, is_veg: 0 },
      { name: 'Veg Spring Rolls', description: 'Crispy rolls with schezwan dip', price: 180, is_veg: 1 },
      { name: 'Tandoori Mushroom', description: 'Marinated mushrooms, clay-oven roasted', price: 220, is_veg: 1 },
    ],
  },
  {
    name: 'Main Course',
    items: [
      { name: 'Paneer Butter Masala', description: 'Rich tomato-cashew gravy', price: 280, is_veg: 1 },
      { name: 'Dal Makhani', description: 'Slow-cooked black lentils', price: 220, is_veg: 1 },
      { name: 'Butter Chicken', description: 'Classic murgh makhani', price: 360, is_veg: 0 },
      { name: 'Kadai Chicken', description: 'Chicken tossed with peppers', price: 340, is_veg: 0 },
      { name: 'Veg Kolhapuri', description: 'Spicy mixed vegetable curry', price: 240, is_veg: 1 },
    ],
  },
  {
    name: 'Breads & Rice',
    items: [
      { name: 'Butter Naan', description: 'Tandoor-baked, brushed with butter', price: 60, is_veg: 1 },
      { name: 'Garlic Naan', description: 'Naan topped with garlic & coriander', price: 75, is_veg: 1 },
      { name: 'Jeera Rice', description: 'Basmati rice with cumin', price: 150, is_veg: 1 },
      { name: 'Veg Pulao', description: 'Fragrant rice with vegetables', price: 190, is_veg: 1 },
    ],
  },
  {
    name: 'Beverages',
    items: [
      { name: 'Masala Chai', description: 'Spiced Indian tea', price: 40, is_veg: 1 },
      { name: 'Sweet Lassi', description: 'Chilled yogurt drink', price: 90, is_veg: 1 },
      { name: 'Fresh Lime Soda', description: 'Sweet / salted / mixed', price: 70, is_veg: 1 },
    ],
  },
  {
    name: 'Desserts',
    items: [
      { name: 'Gulab Jamun', description: 'Two pieces, warm syrup', price: 110, is_veg: 1 },
      { name: 'Rasgulla', description: 'Soft spongy Bengali sweet', price: 100, is_veg: 1 },
    ],
  },
];

async function main() {
  await ensureSchema();
  await runMigrations();

  if (await get("SELECT id FROM tenants WHERE slug = 'demo'")) {
    console.log('Demo restaurant already exists. Skipping seed.');
    console.log('To reset it, delete the DB and run `npm run seed` again.');
    return;
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);

  await transaction(async () => {
    const t = await run(
      `INSERT INTO tenants (name, slug, phone, address, currency, gst_percent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'Spice Garden (Demo)',
        'demo',
        '+91 98765 43210',
        'MG Road, Bengaluru',
        '₹',
        5,
      ]
    );
    const tenantId = t.lastInsertRowid;

    // Staff accounts.
    const users = [
      ['Owner Demo', 'owner@demo.com', 'owner'],
      ['Kitchen Display', 'kitchen@demo.com', 'kitchen'],
      ['Cash Counter', 'cashier@demo.com', 'cashier'],
    ];
    for (const [name, email, role] of users) {
      await run(
        'INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
        [tenantId, name, email, hash, role]
      );
    }

    // Menu.
    let sort = 1;
    for (const cat of DEMO_MENU) {
      const catId = (await run(
        'INSERT INTO menu_categories (tenant_id, name, sort_order) VALUES (?, ?, ?)',
        [tenantId, cat.name, sort]
      )).lastInsertRowid;
      let itemSort = 1;
      for (const item of cat.items) {
        await run(
          `INSERT INTO menu_items (tenant_id, category_id, name, description, price, is_veg, is_available, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          [tenantId, catId, item.name, item.description, item.price, item.is_veg, itemSort++]
        );
      }
      sort++;
    }

    // Tables (each gets a unique QR token).
    for (let i = 1; i <= 8; i++) {
      await run(
        'INSERT INTO tables (tenant_id, name, seats, qr_token) VALUES (?, ?, ?, ?)',
        [tenantId, `Table ${i}`, i <= 4 ? 4 : 6, crypto.randomBytes(9).toString('base64url')]
      );
    }
  });

  const port = process.env.PORT || 3000;
  console.log(`✅ Demo restaurant seeded successfully! (database: ${dialect()})\n`);
  console.log('Logins (password for all: ' + PASSWORD + ')');
  console.log(`  Owner    http://localhost:${port}/admin    owner@demo.com`);
  console.log(`  Kitchen  http://localhost:${port}/kitchen  kitchen@demo.com`);
  console.log(`  Cashier  http://localhost:${port}/cashier  cashier@demo.com`);
  console.log('\nPrint table QR codes from the Admin panel -> Tables & QR tab.');
}

main().catch((err) => {
  console.error('\n❌ Seed failed:', err.message, '\n');
  process.exit(1);
});
