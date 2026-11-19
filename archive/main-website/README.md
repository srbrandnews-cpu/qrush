# Archive — Main Website (Table Ordering Product)

> **Status: ARCHIVED on 2026-11-19.** Yeh folder runtime se bahar hai — server
> ise load nahi karta aur `public/` ke andar nahi hai, isliye web par koi bhi
> ise open nahi kar sakta.
>
> Live website ab **sirf Free Digital QR Menu Generator** hai:
> `/` (free QR landing + owner dashboard), `/m/:slug` (hosted menu),
> `/m/:slug/kitchen` (free QR kitchen board), `/superadmin` (platform console).

Yeh folder **baad mein use karne ke liye** rakha gaya hai. Yahan main website
(table-QR ordering product) ka code, UI aur tests ki **exact copies** hain.
Database ko chhua nahi gaya hai — saara data (tenants, tables, menu items,
orders) DB mein waisa hi hai.

---

## 1. Kya archive hua

### Frontend (public/)
| Path | Kya tha |
|---|---|
| `public/index.html` | Main landing page (table ordering product) |
| `public/admin/` | Venue owner admin panel (menu, tables, staff, settings) |
| `public/kitchen/` | Kitchen display screen (KDS) |
| `public/cashier/` | Cash counter / billing screen |
| `public/login/` | Staff login page |
| `public/menu/` | Customer table menu (voice ordering, PWA) |
| `public/wait/` | `/r/:slug` waiting / live order screen |
| `public/img/landing/` | Landing page photos (7 images) |
| `public/img/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | PWA icons (sirf menu/index use karte the) |
| `public/js/voice.js` | Table-menu voice ordering helper |
| `public/manifest.json` | Table-menu PWA manifest |
| `public/sw.js` | Service worker (main app push notifications) |
| `public/video/qrush-demo.mp4` | Landing page demo video (20 MB) — **git mein nahi** (neeche note) |

### Backend (src/)
| Path | Kya tha |
|---|---|
| `src/routes/menu.routes.js` | `/api/menu` — menu categories/items, CSV import |
| `src/routes/table.routes.js` | `/api/tables` — tables + table QR codes |
| `src/routes/order.routes.js` | `/api/orders` — kitchen/cashier order board |
| `src/routes/request.routes.js` | `/api/requests` — waiter/call requests |
| `src/routes/voice.routes.js` | `/api/voice/tts` — menu voice playback |
| `src/routes/push.routes.js` | `/api/push` — web-push subscriptions (main app) |
| `src/db/seed.js` | Demo restaurant + staff + menu seed (`npm run seed`) |

### Tests / dev scripts
`scripts/test-flow.js`, `test-bill-merge.js`, `test-notifications.js`,
`test-csv-import.js`, `test-encoding.js`, `test-postgres.js`,
`reset-orders.js`

### Kya archive NAHI hua (shared — Free QR ko bhi chahiye)
- `server.js`, `src/config/db.js`, `src/db/init.js`, `src/db/migrations.js`,
  schemas
- `src/middleware/auth.js`, `src/middleware/security.js`
- `src/routes/auth.routes.js` (Super Admin login), `admin.routes.js`
  (Super Admin APIs), `public.routes.js` (free-QR APIs + hosted menus)
- `src/realtime/socket.js`, `src/services/*`, `src/utils/*`
- `public/free-qr.html`, `public/free-qr-kitchen.html`, `public/superadmin/`
- `public/css/app.css`, `public/js/common.js`, `public/img/favicon.png`,
  `qrush-icon.png`, `qrush-logo.png`, `public/img/demo/` (menu photos),
  `public/404.html`
- `public/demo-menu.html` — free-QR landing ka **"Live Demo"** page isi se
  khulta hai, isliye live rakha gaya hai.

> `public/img/logo.png`, `logo.svg`, `logo-white.svg` bhi live hain (brand
> assets, kahin reference nahi hain — chhote hain, isliye chhode gaye).

### DB / data
- **Kuch delete nahi hua.** Tables, menu items, orders, tenants — sab DB mein
  hain. Sirf unka UI/API live nahi hai.
- Backup lena ho to: `npm run backup:db`

### Video note
`archive/main-website/public/video/qrush-demo.mp4` (20 MB) **local par maujood
hai lekin git mein track nahi** (`.gitignore` mein entry hai) taaki repo bhaari
na ho. Naye PC par clone karne ke baad ye file nahi milegi — original repo
history (`public/video/qrush-demo.mp4`) se ya local backup se le lena.

---

## 2. Restore kaise karein (jab baad mein chahiye)

### Step 1 — files wapas copy karein
```powershell
cd "G:\hotel table booking"
Copy-Item archive\main-website\public\* public\ -Recurse -Force
Copy-Item archive\main-website\src\*    src\    -Recurse -Force
Copy-Item archive\main-website\scripts\* scripts\ -Force
```

### Step 2 — `server.js` mein routes wapas add karein

API mounts (`/api/public` ke upar):
```js
app.use('/api/menu', require('./src/routes/menu.routes'));
app.use('/api/tables', require('./src/routes/table.routes'));
app.use('/api/orders', require('./src/routes/order.routes'));
app.use('/api/requests', require('./src/routes/request.routes'));
app.use('/api/push', require('./src/routes/push.routes'));
app.use('/api/voice', require('./src/routes/voice.routes'));
```

Page routes (`app.get('/superadmin', ...)` ke saath):
```js
app.get('/', page('index.html'));           // free-qr.html wali line hata kar
app.get('/login', page(path.join('login', 'index.html')));
app.get('/admin', page(path.join('admin', 'index.html')));
app.get('/kitchen', page(path.join('kitchen', 'index.html')));
app.get('/cashier', page(path.join('cashier', 'index.html')));
app.get('/r/:slug', page(path.join('wait', 'index.html')));
app.get('/menu', page(path.join('menu', 'index.html')));
```

### Step 3 — `package.json` scripts wapas add karein
```json
"seed": "node src/db/seed.js",
"test": "node scripts/test-flow.js",
"test:bill": "node scripts/test-bill-merge.js",
"test:encoding": "node scripts/test-encoding.js",
"test:csv": "node scripts/test-csv-import.js",
"test:notify": "node scripts/test-notifications.js",
"test:pg": "node scripts/test-postgres.js",
"reset:orders": "node scripts/reset-orders.js",
```

### Step 4 — links wapas badlein (optional)
Live free-QR version mein ye links `/` par point karte hain. Restore ke baad
chaahein to wapas `/admin` / `/login` kar dein:
- `public/superadmin/index.html` — "Free QR site" links (2 jagah) + login footer
- `public/superadmin/superadmin.js` — "Free QR site" link
- `public/404.html` — Free QR / Super Admin buttons
- `public/free-qr.html` — owner login ke neeche wala note

### Step 5 — test
```powershell
$env:PORT="3115"; node server.js
# /  /login  /admin  /kitchen  /cashier  /menu  /r/<slug>  sab 200 hone chahiye
```

---

## 3. Ab live kya hai (sirf Free QR)

| URL | Kya |
|---|---|
| `/` ya `/free-qr` | Free QR landing + owner register/login + dashboard |
| `/m/:slug` | Hosted QR menu (customer) |
| `/m/:slug/kitchen` | Free QR kitchen board |
| `/superadmin` | Platform console (plans, payments, revenue, ads, tenants) |
| `/demo-menu.html` | Sample menu (free-QR landing ka Live Demo) |
| `/api/public/free-qr/*` | Register, login, OTP, menu edit, billing, orders |
| `/api/public/m/:slug/*` | Hosted menu + ordering APIs |
| `/api/admin/super-admin/*` | Platform console APIs |
| `/api/auth/*` | Super Admin login/session |

Backend mein `admin.routes.js` ke purane venue-admin endpoints abhi code mein
hain (Super Admin file share karti hai) lekin unka koi UI live nahi hai.
