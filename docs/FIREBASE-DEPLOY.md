# 🚀 Firebase App Hosting par deploy (Online)

**Yehi sabse aasaan tarika hai bina kisi server ke.** Firebase ka App Hosting Cloud Run
par chalta hai — aapko na VPS khareedni hai, na Linux sambhalna hai, na Nginx config
karni hai. Sirf ek GitHub repo aur kuch environment variables.

**Aapko chahiye:**
| Cheez | Cost | Time |
|---|---|---|
| Firebase project (Spark plan) | Free | 2 min |
| GitHub repo | Free | 2 min |
| Neon Postgres (free tier) | Free | 3 min |
| Domain (optional, QR permanent ke liye) | ₹700–1200/yr | 5 min |
| Firebase App Hosting | Free se start (usage-based) | 10 min |

---

## Step 1 — Firebase project banao

> ⚠️ **App Hosting ke liye Blaze (pay-as-you-go) plan chahiye** — Google account par ek card
> add karna padega. Free tier ka monthly credit lagta hai, isliye 1-2 restaurant ka
> kharcha practically **₹0–200/month** aata hai. (Card nahi hai to neeche "VPS" wala
> rasta dekhein.)

1. https://console.firebase.google.com → **Add project**
   - Project name: `tablenest` (ya jo pasand ho)
   - Google Analytics: **off** rakhein (zaroorat nahi)
2. Firebase console khula ho → left menu → **Build** → **App Hosting** → **Get started**
3. App Hosting ka default backend ban jayega. Region **asia-south1 (Mumbai)** rakhein —
   India ke customers ke liye sabse fast.
4. Runtime: **Node.js 22 ya 24** chunein (`package.json` mein `"engines": ">=22"` set hai —
   in dono mein se koi bhi chalega).


---

## Step 2 — Postgres database (Neon — free)

Neon ka free tier 0.5 GB deta hai — shuru ke 10-20 restaurants ke liye kaafi hai.

1. https://neon.tech → **Sign up** (GitHub se) → **Create a project**
   - Region: **India (Mumbai)** / Singapore
   - Name: `tablenest-db`
2. Neon dashboard → **Connect** → **Connection string**
   - ⚠️ **Pooled connection** copy karein (direct nahi — serverless ke liye pooled zaroori hai)
   - Format: `postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/tablenest?sslmode=require`
3. Connection string kahin safe rakh lo — Step 5 mein daalna hai.

---

## Step 3 — GitHub repo banao (code upload)

1. https://github.com → **New repository** → name: `tablenest`
   - Visibility: **Private** rakhein (ya Public — code MIT licensed hai, dono chalega)
2. Terminal mein (project folder mein):

```bash
git remote add origin https://github.com/AAPKA-USERNAME/tablenest.git
git branch -M main
git push -u origin main
```

> Git pehle se installed aur repo init + commit ho chuka hai — bas `remote add` aur `push`.

---

## Step 4 — App Hosting se GitHub repo connect karo

Firebase console → **App Hosting** → apna backend → **Settings** → **Integrations** →
**Add integration** → **GitHub** → apna repo select karo → **Connect**.

> Firebase aapko GitHub pe authorize karne ko kahega — "Only select repositories" chunein
> aur sirf `tablenest` select karein.

---

## Step 5 — Environment variables set karo (⚠️ sabse zaroori step)

App Hosting console → apna backend → **Environment variables** → **Add**:

| Variable | Value | Note |
|---|---|---|
| `DB_CLIENT` | `postgres` | **zaroori** — SQLite yahan kaam nahi karega |
| `DATABASE_URL` | Neon ka connection string | **zaroori** |
| `JWT_SECRET` | 64+ character random | **zaroori** — neeche command hai |
| `BASE_URL` | *(khali chhod dein)* | optional — QR code khud current hostname se banta hai |
| `VAPID_PUBLIC_KEY` | neeche generate karke | push notifications ke liye |
| `VAPID_PRIVATE_KEY` | neeche generate karke | **dhyan se** — kho gaya to customers ko dobara allow karna padega |
| `VAPID_SUBJECT` | `mailto:aapka@email.com` | support email |
| `NODE_ENV` | `production` | `apphosting.yaml` mein pehle se set hai |
| `PGPOOL_MAX` | `10` | optional — `apphosting.yaml` mein set hai |

> **`BASE_URL` kyun khali?** QR code ab request ke hostname se khud ban jaata hai.
> Matlab default `*.hosted.app` URL par bhi sahi, aur baad mein custom domain lagane par bhi
> sahi — dobara deploy karne ki zaroorat nahi. Sirf tab set karein jab aap **force** karna
> chahte hain ki QR hamesha ek hi domain par jaye.

**Random JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**VAPID keys (ek baar generate karke dono jagah same use karein):**
```bash
node scripts/generate-vapid.js
```
> Ye command `.env` mein bhi likh deti hai — wahi values App Hosting mein daal dein.

> **⚠️ VAPID keys kyun zaroori?** App Hosting ka filesystem temporary hai. Agar keys env mein
> nahi hain to har deploy par nayi keys banti hain aur **har customer ka notification**
> permanently toot jaata hai. Env mein set karne se keys hamesha same rehti hain.

---

## Step 6 — Deploy

App Hosting console → **Build** → **Create a rollout** → **Deploy**.

Build 2-4 minute lagega. Logs mein dikhega:
```
🚀 TableNest running  (database: PostgreSQL)
```

**Agar warning dikhe** to app shuru hote hi console mein likh deta hai
(galat config ka pata chal jayega).

---

## Step 7 — Verify

| Check | Kahan |
|---|---|
| App khula? | `https://<apna-project>.web.app` |
| Health check | `https://<apna-project>.web.app/api/health` → `{"ok":true}` |
| DB connected? | Server log mein `database: PostgreSQL` |
| Order chal raha? | Customer menu → order → Kitchen screen |
| Push chalta hai? | HTTPS hai + VAPID env mein set hai ✅ |

---

## Step 8 — Apna domain lagao (QR permanent ke liye)

1. App Hosting → **Settings** → **Custom domains** → **Add custom domain**
2. Apna domain daalein (e.g. `order.myhotel.in`)
3. Firebase DNS records automatically set kar deta hai (CNAME) — agar aapke registrar
   par Cloudflare use kar rahe ho to wahan bhi CNAME add karna padega
4. SSL certificate Firebase khud manage karta hai — **kuch karne ki zaroorat nahi** ✅

Bas! QR codes automatically naye domain par point karenge — `BASE_URL` set karne ya
redeploy karne ki zaroorat nahi. ✅

> ⚠️ **QR stickers domain lagne ke BAAD print karein.** Pehle `*.hosted.app` URL par print
> kiye gaye QR purane link par jayenge.


> **Domain kahan se lo?** → `docs/DOMAIN-SETUP.md` (Cloudflare Registrar sabse sasta hai)

---

## 🔁 Aage updates kaise push karein?

```bash
git add -A
git commit -m "naya feature"
git push
```
App Hosting **automatically** redeploy ho jayega (auto-deploy ON hai).

---

## 💰 Kitna kharcha aayega?

| Item | Cost (approx) |
|---|---|
| Firebase App Hosting | Free tier (Spark) → low usage pe ~$0-5/month |
| Neon Postgres | **Free** (0.5 GB) → 50+ restaurants tak |
| Domain (optional) | ₹700–1200/saal |
| **Total (2 restaurants)** | **≈ ₹0–500/month** |

---

## ❓常见 problems

| Problem | Solution |
|---|---|
| "Database connection failed" | `DATABASE_URL` check karein — **pooled** URL honi chahiye, `?sslmode=require` bhi |
| App boot nahi hua | App Hosting → **Logs** dekhein — hamare production warnings exact bata denge |
| Push notifications nahi aa rahe | `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` env mein hain ya nahi check karein |
| QR codes galat link bana rahe | Normally automatic hai. Agar `BASE_URL` env set kiya hai to use hata dein — QR request ke host se banega |
| Build fail | `npm ci` chahiye `package-lock.json` — woh repo mein hai ✅. Node runtime `engines` (`>=22`) se match karna chahiye |
| Kitchen ko naya order nahi dikh raha | Instances 1 se zyada na hon — Socket.IO ka shared adapter nahi hai, isliye `apphosting.yaml` mein `maxInstances: 1` set hai. Ise na badhayein |
| Pehla order 2-5 sec slow | Normal — idle hone par server scale-to-zero hota hai. Always-warm chahiye to `minInstances: 1` karein (par ~$50/month) |
| 5xx errors traffic ke saath | `maxInstances` / `concurrency` badhaayein (`apphosting.yaml`) |

---

## 🔄 Ek aur rasta (aap interest chahein to)

Firebase ki jagah **plain VPS** (DigitalOcean/Vultr, ~₹500-700/mo) bhi chalta hai —
`docs/DOMAIN-SETUP.md` usi ke liye hai. Difference:

| | Firebase App Hosting | VPS |
|---|---|---|
| Setup time | 10 min | 30 min |
| Server chahiye? | Nahi | Haan (manage karna padta hai) |
| Scaling | Automatic | Manual |
| Cost (small scale) | ~₹0-500/mo | ~₹500-700/mo (fixed) |
| Custom domain | Free SSL ✅ | Free SSL (certbot) |
