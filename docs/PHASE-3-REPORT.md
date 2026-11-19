# QRUSH — Phase 3: Monetization (Free Digital QR Menu Generator)

**Status:** ✅ Local implementation complete, 14/14 tests passing. **Not deployed to production yet.**
**Scope:** Sirf **Free Digital QR Menu Generator** (`free_qr` track). Main website (`/admin`) aur table-QR→bill flow ko **chhua nahi gaya**.

---

## 1. Kya bana

### A. Super Admin — Settings (platform config)
Sab kuch database se configurable, koi hardcoded value nahi:

| Setting | Default |
|---|---|
| `whatsapp_number` | *(khali — configure karna zaroori)* |
| `whatsapp_support_message` | "Hello QRUSH Team, I want to upgrade..." |
| `default_subscription_duration_days` | 30 |
| `grace_period_days` | 7 |
| `plan_free_price` / `plan_starter_price` / `plan_business_price` | 0 / 149 / 299 |
| `plan_free_features` / `plan_starter_features` / `plan_business_features` | text |
| `ad_enabled` | 0 (OFF — Super Admin ke Settings se on hoga) |

### B. Super Admin — Subscriptions (manual payments only)
- Pending payment list (filter: status, plan)
- **Confirm** → plan activate (admin action mandatory)
- **Reject** → record rejected, plan nahi badalta
- **Refund** → plan wapas Free
- **Check Expiry** → grace period ke baad Free par shift
- Har action `subscription_history` mein audit log hota hai (admin email ke saath)

### C. Super Admin — Revenue dashboard
- Total / Free / Starter / Business / Pending / Expired counts
- Total collected + this month (sirf **confirmed** payments)
- Ad performance: active ads, impressions, clicks
- **Koi estimated/fake revenue nahi**

### D. Super Admin — Ads manager
- Create / Edit / Pause / Activate / Delete
- Image URL validation (https only), destination URL validation
- Placement, start/end date schedule
- Per-ad impressions & clicks (deduped: 1 per visitor per day)

### E. Free QR owner — "My Plan & Billing" (free-qr.html dashboard)
- Current plan, status, expiry, days left
- Plan comparison cards (Free / Starter / Business) — prices settings se
- **Upgrade** → pending payment banata hai + WhatsApp link kholta hai
- Payment history
- Agar WhatsApp number configured nahi → graceful message: *"WhatsApp number not configured. Please contact support."*
- Owner **apna plan khud nahi badal sakta** (API 401)

### F. Public menu (`/m/:slug`) — Advertisement slot
- **Abhi OFF hai** (`ad_enabled = 0`). Ads tab dikhenge jab Super Admin → Settings se toggle on karein (restaurants badhne ke baad).
- Sirf **Free plan** restaurants par dikhta hai
- "Advertisement" label ke saath
- Paid plans (Starter/Business) **ad-free**
- Impression + click tracking (deduped)

### G. Premium QR code
- Download 1024px PNG
- Footer: restaurant ka naam + "Scan to view our menu" + QRush logo
- Error correction level H (logo/screenshot ke baad bhi scan hota hai)

---

## 2. Files changed

| File | Kya |
|---|---|
| `src/db/migrations.js` | Migration 010 (5 tables), 011 (free_qr_id/payment_type), 012 (tenant_id nullable) |
| `src/routes/admin.routes.js` | Settings, payments, ads CRUD, revenue, expiry, history |
| `src/routes/public.routes.js` | Free-QR billing API, public ads API, ad slot on `/m/:slug` |
| `src/middleware/auth.js` | `requireAuth` freeqr token ko 401 deta hai (500 nahi) |
| `public/free-qr.html` | Billing card + premium QR + `esc()` helper |
| `public/superadmin/index.html` | Subscriptions / Revenue / Settings / Ads panels |
| `public/superadmin/superadmin.js` | loaders + actions for all panels |

**Untouched:** `public/admin/*` (main website), table QR → order → bill flow, kitchen, cashier.

---

## 3. Database

New tables (migration 010):
- `admin_settings`
- `subscription_payments`
- `subscription_history`
- `advertisements`
- `ad_events`

Extended:
- 011 → `free_qr_id`, `payment_type` on payments + history
- 012 → `tenant_id` nullable (Free-QR payments ka koi tenant nahi hota)

Migrations idempotent hain — har boot par safely chalte hain.

---

## 4. Test results (14/14 ✅)

| Test | Result |
|---|---|
| Owner khud plan activate nahi kar sakta | PASS (401) |
| Upgrade request → pending payment | PASS |
| Pending ≠ Active (plan free rehta hai) | PASS |
| Duplicate pending request block | PASS |
| Cross-restaurant isolation | PASS |
| Admin confirm → plan active | PASS |
| Paid plan ad-free (API + page) | PASS |
| Public menu / QR intact | PASS |
| Revenue sirf confirmed count karta hai | PASS |
| Refund → wapas Free | PASS |
| Free plan par ads wapas | PASS |
| Audit history record | PASS |
| Expiry → Free (grace ke baad) | PASS |

---

## 5. Local dekhne ke links

| Kya dekhein | URL |
|---|---|
| Free QR owner billing | `http://localhost:3115/free-qr.html` (login → dashboard) |
| Super admin panels | `http://localhost:3115/superadmin` → Subscriptions / Revenue / Settings / Ads |
| Public menu + ad | `http://localhost:3115/m/738486ca79e7` |

Login (local only): `owner@demo.com` / `pass1234`

---

## 6. Deploy ke pehle zaroori

1. **WhatsApp number set karein** — Super Admin → Settings → `whatsapp_number` (country code ke saath, jaise `919876543210`). Khali chhoda to upgrade button support message dikhayega.
2. Prices/features apne hisaab se check kar lein.
3. Production DB par migration 010–012 automatically chalengi (koi manual SQL nahi).

## 7. Deploy / rollback

- Deploy: Render par commit push → auto-deploy (ya manual "Deploy latest commit").
- Rollback: Render → Events → pichla deploy → "Rollback".
- Migrations additive hain — rollback se data delete nahi hota.

---

## 8. Abhi baaki (out of scope / future)

- Subscription expiry automatic scheduler (abhi manual "Check Expiry" button hai; chahein to cron lag sakta hai)
- Ad revenue ka separate ledger (abhi impressions/clicks track hote hain, CPM/earning calculate nahi hota)
- Payment gateway (design ke mutabik **nahi** — sirf manual WhatsApp + admin confirmation)
