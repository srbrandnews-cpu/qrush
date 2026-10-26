# QRush — Restaurant QR Table Ordering (SaaS)

Customer table par laga **QR code scan** karta hai → apna **order** khud place karta hai →
order seedha **kitchen** aur **cash counter** par live pahunchta hai → jaise hi order **ready**
hota hai, customer ke phone par **push notification** chali jaati hai → table par serve.

Multi-tenant hai — ek hi system par aap kayi restaurants chala sakte hain (bechne ke liye bhi ready).

### ✨ Table service, sirf QR menu nahi

- **One-tap table requests** — water, spoon, bill, AC, waiter; kitchen + cashier screens par live chip.
- **Photo-led QR menu** — venue header (Call / WhatsApp / prep-time chips), "All Items" + category chips with scroll-spy, aur har dish ka photo card. Photo na ho (ya link toot jaye) to dish ka emoji tile dikhta hai.
- **One bill per phone** — same table + same number ke add-on items ek hi bill mein; alag number = alag bill (`Table 1A`).
- **Live queue & ETA** — customer ko "Queue #2 · ~8 min" dikhta hai.
- **Spoken welcome + kitchen callout** — QR scan par venue ka welcome note + natural voice; kitchen naye order English/Hindi mein announce karta hai (10 alert sounds ke saath).
- **UPI on the phone** — ready/served bill par `upi://pay` link, full ya equal split (÷2/÷3/÷4). Koi gateway fee nahi.
- **Rush mode** — peak hours mein customer ko sirf "quick" items; full menu one tap away.
- **QRush score + heatmap** — owner ko average prep time, on-time %, hourly rush chart.
- **Emoji feedback** — customer 1-tap rating; owner dashboard par average + latest comments.
- **Branded table tents** — QR ke saath venue name, WiFi aur UPI; print-ready.
- **Public wait page** — `/r/<slug>` par live queue/ETA (bina login).
- **Dark mode** — har screen par light/dark toggle (kitchen display always dark). Choice browser mein yaad rehti hai.
- **Landing page** — photo hero + gallery, topbar par staff **login icon**, aur **New restaurant** tab jo seedha WhatsApp chat kholta hai (prefilled message ke saath). Number badalna ho to `public/index.html` ke bottom script mein `QRUSH_WA` constant edit karein.

---

## ⚡ Sabse pehle: kaise kholein

> **Zaroori:** HTML files ko directly (double-click) mat kholein — browser mein blank dikhega kyunki
> server chahiye. Hamesha neeche ka method use karein.

### 🎯 Online mode (recommended — permanent URL, free)

**`start-online.bat` par double-click karein.**

Aapka permanent address ban jata hai:

```
https://tablenest.tail0010e0.ts.net
```

- URL **kabhi nahi badalta** → QR ek hi baar print karna hai
- Free, koi card nahi
- Staff login bhi persist karta hai

> ⚠️ Laptop on rehna chahiye (app aapke laptop par chalta hai, internet par tunnel se
> dikhta hai). Detail → [`docs/ONLINE-TAILSCALE.md`](docs/ONLINE-TAILSCALE.md)

### 🔄 Temporary tunnel mode (sirf quick test)

**`start-tunnel.bat` par double-click karein.** Yeh:

1. ek **free public HTTPS URL** banata hai (Cloudflare tunnel — koi account/domain nahi chahiye),
2. usse `.env` mein `BASE_URL` ke roop mein likh deta hai (QR codes apne aap update ho jate hain),
3. server start kar deta hai aur browser kholta hai.

Isse customer **aapke ghar ke WiFi se bhi** (bina same network ke) QR scan karke order kar sakta hai,
aur **web push notification bhi chalta hai** (HTTPS hone ki wajah se).

> ⚠️ Quick-tunnel ka URL har restart par badal jaata hai. **QR print karne se pehle yeh script dobara
> chala lein** taaki QR sahi rahe. **Permanent URL** ke liye `start-online.bat` use karein.

### 📚 Setup guides

| Guide | Kab padhein |
|---|---|
| **[`docs/ONLINE-TAILSCALE.md`](docs/ONLINE-TAILSCALE.md)** | **Permanent free URL chahiye** — Tailscale Funnel (`start-online.bat`) |
| **[`docs/FREE-DEPLOY.md`](docs/FREE-DEPLOY.md)** | **Cloud par deploy karna hai (bina card)** — Render + Neon + GitHub |
| **[`docs/FIREBASE-DEPLOY.md`](docs/FIREBASE-DEPLOY.md)** | Firebase App Hosting (Blaze plan / card chahiye) |
| **[`docs/DOMAIN-SETUP.md`](docs/DOMAIN-SETUP.md)** | Apna **professional domain** lagana hai (₹700–1200/saal) |

### 🏠 Local mode (sirf ghar par test karna hai)

**Windows par:** `start.bat` par double-click karein.
Woh dependencies install karega, demo data banayega, server start karega aur browser kholega.

**Ya manually (terminal mein):**

```bash
npm install          # pehli baar
npm run seed         # demo restaurant banana ho toh
npm start            # server chalu karo
```

Phir browser mein kholein: **http://localhost:3000**

---

## 🔑 Demo logins (password sabke liye: `pass1234`)

| Screen | URL | Email |
|---|---|---|
| Landing / product page | http://localhost:3000/ | — |
| **Owner** admin panel | http://localhost:3000/admin | `owner@demo.com` |
| **Kitchen** display | http://localhost:3000/kitchen | `kitchen@demo.com` |
| **Cash** counter | http://localhost:3000/cashier | `cashier@demo.com` |
| **Platform** console (super admin) | http://localhost:3000/superadmin | `owner@demo.com` |
| **Customer** menu (QR scan) | http://localhost:3000/menu?table=**&lt;token&gt;** | koi nahi |

Customer wala link har table ka alag hota hai. Token Admin → **Tables & QR** tab mein mil jayega
(wahin se QR code print kar sakte hain). Har QR usi table ka menu kholt hai.

> **Public signup band hai.** Naya restaurant sirf platform admin `/superadmin` se add karta hai.
> Login page par demo credentials nahi dikhte — apne staff ko credentials alag se bhejein.
> Live URL share karne se pehle `owner@demo.com` ka password badal dein (Admin → Staff).

---

## 🔁 Poori order ki kriya (flow)

1. **Customer** table ke QR ko scan karta hai → menu khulta hai.
2. Items cart mein daal kar **Place order** (naam optional).
3. **Kitchen screen** par pop + sound ke saath order aata hai:
   `Accept` → `Start preparing` → `Mark ready`.
4. **`Mark ready` karte hi** customer ke phone par **push notification** chali jaati hai
   + screen par live status (progress bar) update hota hai.
5. **Cash counter** par order dikhta hai → `Mark served` (table par pahuncha) →
   `Collect payment` (Cash / UPI / Card) → bill with GST.
6. Customer ko sab kuch live dikhta rehta hai: `Placed → Accepted → Preparing → Ready → Served`.

Payment **cash counter par** hoti hai (online payment baad mein add kar sakte hain).

---

## 🛠️ Owner kya-kya kar sakta hai (Admin panel)

- **Dashboard** — aaj ke orders, revenue, top items, live orders, aur **setup checklist**
  (hamesha dashboard par rehta hai; har step ke saath "Karein" button, aur upar toggle se
  chhupa sakte hain). Restaurant owner khud step-by-step setup kar sakta hai.
- **Menu** — categories aur dishes add/edit/delete, veg/non-veg, price, availability toggle.
  Har item par **Photo URL** (public jpg/png/webp link) + thumbnail preview; customer menu par
  photo card, photo na ho to emoji tile. **📥 Import CSV** se poora menu 1 minute mein
  (missing categories apne aap ban jaate hain; CSV ka `image` column bhi chalta hai).
- **Tables & QR** — table add (ya bulk mein 10–200), QR code print karke table par lagana.
- **Staff** — kitchen aur cashier ke alag accounts banayein.
- **🔔 Notifications** — browser push channel aur delivery log.
- **Settings** — restaurant ka naam, phone, address, currency (₹), GST %.

---

## 🏛️ Platform console (super admin)

Sirf platform owner ke liye alag screen: **`/superadmin`**. Yahan se poora QRush network manage hota hai —
ek restaurant ka owner login ise nahi khol sakta (403 + "access required" screen).

`/superadmin` khulte hi ek dedicated **orange platform sign-in** screen aati hai (venue ke teal
screens se alag identity, hamesha light). Role select karne par login sahi jagah le jaata hai:

| Role | Kahan khulta hai |
| --- | --- |
| **Super Admin** | Platform console (sirf allowlisted emails) |
| **Restaurant Owner** | Venue admin `/admin` |
| **Kitchen** | Live orders `/kitchen` |
| **Cashier** | Bills & payments `/cashier` |

Galat role chuna ho to saaf message milta hai (jaise kitchen account se Super Admin login),
aur har role ka last-used email yaad rehta hai.

### Role sign-ins (owner / kitchen / cashier)
Ek hi browser me super-admin session chalta rehta hai, isliye platform console ke **topbar** ya
**sidebar** me **Role sign-ins** button hai — wo `/superadmin?login=1` kholta hai. Ye URL
hamesha orange sign-in card dikhata hai (super admin logged-in ho tab bhi), taaki owner, kitchen
ya cashier ka login test kiya ja sake. Card par **Back to console** link aata hai, aur staff
login se super-admin ka session nahi tootta. Venue admin (`/admin`) ke sidebar me bhi super
admins ko **Role logins** link milta hai.

- **Overview** — total restaurants, owners/staff, aaj ke orders aur revenue, guest rating,
  top venues, newest venues aur "needs attention" (menu/tables missing, suspended venue, rush).
- **Restaurants** — search + status/sort filters, har venue ka today/all-time revenue, setup
  (tables/items/staff), last order. **Manage** se:
  - customer menu kholna, naam/phone edit karna,
  - owner ka password/email reset karna (support ke liye),
  - venue suspend/activate (QR menu band/chalu — data safe),
  - venue permanently delete (type-the-name confirmation).
- **New restaurant** — restaurant + owner account ek hi step mein banta hai, aur ready-to-send
  credentials (email + generated password + admin URL) copy karne ko milte hain.
- **Access & health** — kaun platform admin hai, database/runtime/uptime, health check aur
  security checklist.

Access email allowlist se milta hai: default `srbrandnews@gmail.com` aur `owner@demo.com`.
Production mein `SUPER_ADMIN_EMAILS` env var se override karein (comma separated).

**Kya safe hai:** apna hi workspace suspend/delete nahi hota, demo tenant delete nahi hota,
aur normal owner ko platform APIs 403 dete hain.

---

## 📁 Project structure

```
hotel-table-booking/
├── start.bat                 # Windows: double-click se server start
├── server.js                 # Express + Socket.io server (entry point)
├── src/
│   ├── config/db.js          # database layer (SQLite + PostgreSQL, ek hi API)
│   ├── db/schema.sql         # SQLite schema
│   ├── db/schema.postgres.sql# PostgreSQL schema (same structure)
│   ├── db/init.js            # schema create on boot (dialect-aware)
│   ├── db/seed.js            # demo restaurant data
│   ├── middleware/auth.js    # JWT + role checking + super-admin allowlist
│   ├── routes/               # auth, menu, tables, orders, admin, public, push
│   ├── services/orders.js    # order + status + notification logic (core)
│   ├── services/push.js      # web push (VAPID keys auto-generate)
│   ├── realtime/socket.js    # live updates for kitchen/cashier/customer
│   └── utils/                # constants (status flow), QR helper
├── public/
│   ├── index.html            # landing page
│   ├── login/  admin/  kitchen/  cashier/  menu/  superadmin/
│   ├── sw.js                # service worker (push notifications)
│   ├── css/app.css          # shared design system
│   └── img/                 # generated app icons
├── scripts/
│   ├── make-icon.js         # app icons banata hai (PNG)
│   ├── test-flow.js         # end-to-end order flow test
│   ├── test-bill-merge.js   # same-table add-on / separate-phone bills
│   ├── test-superadmin.js   # platform console + tenant CRUD test
│   ├── test-postgres.js     # wahi test, real PostgreSQL par
│   └── reset-orders.js      # demo orders clean karta hai
└── data/                    # SQLite database + VAPID keys (auto-create, gitignored)
```

---

## ⚙️ Settings (`.env` file)

| Variable | Matlab |
|---|---|
| `PORT` | Server port (default `3000`) |
| `BASE_URL` | Wo URL jo phone QR scan par kholega. **LAN demo:** `http://192.168.x.x:3000`, **prod:** `https://order.aapka-domain.com` |
| `JWT_SECRET` | Login token sign karne ke liye — production mein zaroor badlein |
| `VAPID_SUBJECT` | Web push ke liye support email |
| `SUPER_ADMIN_EMAILS` | Platform console (`/superadmin`) ke allowed emails, comma separated. Default: `srbrandnews@gmail.com,owner@demo.com` |

> **Phone se test karne ke liye:** dono (laptop + phone) same WiFi par hon, aur `BASE_URL`
> mein laptop ka LAN IP daalein (cmd mein `ipconfig` se malum hoga). QR tabhi phone par scan hoga.

---

## 🧪 Testing

```bash
npm start              # server chalu rakhein (alag terminal mein)
npm test               # poora order-flow test (SQLite)
npm run test:bill     # same-table add-on / separate-phone bill rules
npm run test:superadmin # platform console: KPIs, tenant CRUD, access guards
npm run test:csv       # CSV menu import test
npm run test:encoding  # UTF-8 safety (हिन्दी नाम, emoji, ₹)
npm run test:notify    # browser push pipeline (delivery log)
```

Yeh poori journey test karta hai: login → order place → kitchen → ready notification →
cashier payment → role guards.

**PostgreSQL par wahi test** (Docker/psql ki zaroorat nahi — embedded PG khud boot hota hai):

```bash
npm run test:pg
```

Yeh real PostgreSQL server boot karke app uspar chalata hai, poora flow test karta hai,
platform console test bhi chalata hai, aur confirm karta hai ki data sach mein Postgres tables mein gaya.

**CSV import format** (template bhi admin panel se download hota hai):

```csv
Category,Item Name,Description,Price,Veg
Starters,Paneer Tikka,"Char-grilled cottage cheese, mint chutney",260,Veg
Starters,Chicken Tikka,Smoky tandoori skewers,320,Non-veg
Beverages,Masala Chai,Spiced tea,₹40,Veg
```

`₹260`, `"1,200"` jaise price formats bhi chalte hain. Galat rows report hoti hain aur
import nahi rukta — aur koi bhi item galat price (₹0) ke saath save nahi hota.

---

## 🔔 Push notifications ke baare mein

- **HTTPS ya localhost** zaroori hai (browser security rule) — LAN IP par sirf screen alerts chalenge,
  push nahi. Production mein domain + SSL lagate hi push kaam karne lagega.
- VAPID keys pehli baar server chalne par khud generate ho kar `data/vapid.json` mein save ho jaati hain.
- Customer ko browser mein permission deni padti hai (menu par 🔔 button).

---

## 🔔 Notifications (browser push)

Order **ready** hote hi customer ke phone par browser notification jaata hai.

- Customer ko ek baar **"Allow"** karna hota hai — koi app install nahi karni.
- Customer ka **order status** usi screen par live progress bar dikhata rehta hai
  (Placed → Accepted → Preparing → Ready → Served), chahe notification aaye ya na aaye.
- Owner admin → **🔔 Notifications** tab mein **delivery log** dekhta hai
  (kiske phone par gaya, gaya ya skip hua aur kyun).
- Koi SMS/WhatsApp provider nahi chahiye — **zero cost, zero setup**.

> WhatsApp/SMS channels hata diye gaye hain (paid provider, template approval aur DLT
> registration ki zaroorat thi). Code `src/services/notify.js` mein comment ke saath
> preserve hai — kisi restaurant ke liye zaroorat pade to wapas laaya ja sakta hai.

---

## 🗄️ Database — SQLite ya PostgreSQL (dono ready)

App **dono drivers** par chalta hai aur code **bilkul same** rehta hai. Sirf `.env` mein switch karo:

```bash
# .env
DB_CLIENT=postgres
DATABASE_URL=postgresql://user:password@host:5432/tablenest
```

| | SQLite (default) | PostgreSQL (production) |
|---|---|---|
| Setup | **zero** — file ban jaati hai | VPS par ek server |
| Aapke liye | dev, demo, chhoti restaurants (10–20) | unlimited restaurants, high traffic |
| Concurrency | ek hi connection | connection pool (10+ parallel) |
| Backups | file copy | `pg_dump` cron |

**Kaise kaam karta hai:**
- `src/config/db.js` ek hi async interface deta hai (`query` / `get` / `run` / `transaction`) — dono drivers ke liye.
- SQL mein hamesha `?` placeholder likhte hain; Postgres ke liye automatically `$1..$N` ban jaata hai.
- `INSERT` par automatically `RETURNING id` lagta hai, isliye `lastInsertRowid` dono par same chalta hai.
- Timestamps dono par **same text format** mein store hote hain (`YYYY-MM-DD HH:MM:SS`, UTC) — frontend ko koi farak nahi padta.
- Transactions Postgres par ek hi connection par pin hoti hain (`AsyncLocalStorage`), isliye nested queries bhi usi transaction mein rehte hain.

**Schema alag file mein hai:** `src/db/schema.sql` (SQLite) aur `src/db/schema.postgres.sql` (Postgres) — dono ka structure bilkul same hai.

### Local machine par Postgres test karna

Is repo mein ek **throwaway embedded PostgreSQL** hai — Docker ya psql ki zaroorat nahi:

```bash
npm run test:pg      # PG boot karta hai, app uspar chalata hai, poora flow test
npm run pg:check     # sirf PG hi test karna ho
```

Yeh E2E test real PostgreSQL par poora order flow chalata hai (login → order → kitchen → ready → payment → role guards) aur confirm karta hai ki rows sach mein Postgres mein gire.

### Production par migrate karna (SQLite → Postgres)

```bash
# 1. Postgres DB banao aur schema chalao (server boot par khud ban jata hai)
DB_CLIENT=postgres npm start

# 2. Purana data migrate karo
sqlite3 data/tablenest.db .dump | psql $DATABASE_URL
```

---


## 🚀 Online deploy

**Sabse aasan tarika: Firebase App Hosting** (no server, auto-scale, free SSL).
Poora step-by-step → **[`docs/FIREBASE-DEPLOY.md`](docs/FIREBASE-DEPLOY.md)**

| | Firebase App Hosting | VPS (DigitalOcean/Vultr) |
|---|---|---|
| Setup time | ~10 min | ~30 min |
| Server khareedna? | Nahi | Haan (~₹500-700/mo) |
| Scaling | Automatic | Manual |
| Custom domain + SSL | Free, automatic | Free (certbot) |
| Database | Neon Postgres (free tier) | Same VPS par Postgres |

**Deployment ke liye sab ready hai:**
- `Dockerfile` — Firebase / Cloud Run / Render / Railway / VPS — sab ke liye
- `apphosting.yaml` — App Hosting config (region `asia-south1` = Mumbai)
- `firebase.json` — Firebase CLI config
- `scripts/generate-vapid.js` — stable push keys generate karta hai
- Server **boot par khud check karta hai** ki production config sahi hai ya nahi
  (galat `DB_CLIENT`, missing VAPID keys, non-HTTPS `BASE_URL` → clear warning)

---

## 🚀 Production / bechne ke liye (SaaS)

- Ek hi Node process kai restaurants (tenants) handle karta hai — har data `tenant_id` par scoped hai.
- Dono drivers ready hain: `DB_CLIENT=sqlite` (dev) ya `DB_CLIENT=postgres` (production).
- `pm2` / Docker + Nginx (HTTPS) + domain laga kar deploy karein.
- Online payment (Razorpay/Cashfree) `src/services/orders.js` mein add kar sakte hain.

---

## License

MIT — chahein toh apne naam se bech/sublish kar sakte hain.
