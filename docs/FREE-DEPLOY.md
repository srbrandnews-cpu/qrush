# 🆓 Free Deploy — Render + Neon + GitHub (bina card)

Ye guide **testing ke liye** hai: free subdomain par app online chalega, **₹0 kharch**,
koi credit card nahi. Jab app perfect lage, tab professional domain laga denge —
**code mein kuch change nahi karna padega** (QR codes khud naye domain par chale jayenge).

| Cheez | Kya milega | Cost |
|---|---|---|
| GitHub | code ka backup + Render ko source | Free, no card |
| Neon | Postgres database | Free, no card (0.5 GB) |
| Render | app chalega 24/7 | Free, no card (750 hrs/month) |
| URL | `https://tablenest-xxxx.onrender.com` | Free |

**Total: ₹0/month.** Baad mein domain chahiye to ~₹700–1200/saal.

---

## ⚠️ Free tier ki sachchai (pehle padh lein)

| Cheez | Free tier |
|---|---|
| 15 min traffic nahi → app so jaata hai | Agli request ~50 sec leti hai |
| RAM / CPU | 512 MB / 0.1 CPU (1–2 restaurant ke liye kaafi) |
| Instance hours | 750/month (ek service 24/7 = ~730 hrs — fit ho jaata hai) |
| Bandwidth | 5 GB/month |

> **Cold start ka ilaaj (Step 6):** ek free cron service har 10 minute `/api/health`
> ko ping kare — app kabhi nahi soyega. Restaurant ke liye ye zaroori hai, warna lunch
> mein pehla QR scan 50 second le sakta hai.

---

## Step 1 — GitHub account + repo

1. https://github.com → **Sign up** (free, card nahi chahiye)
2. Login ke baad → **+** → **New repository**
   - Name: `tablenest`
   - Visibility: **Private** (ya Public — code MIT hai, dono chalega)
   - "Add a README" **tick na karein**
   - **Create repository**
3. Project folder mein ye chalayein (`AAPKA-USERNAME` badal dein):

```bash
git remote add origin https://github.com/AAPKA-USERNAME/tablenest.git
git branch -M main
git push -u origin main
```

> **Password nahi chalega.** Push karte waqt browser khulega (Git Credential Manager) —
> wahan GitHub login kar lein. Ya GitHub → Settings → Developer settings →
> Personal access tokens → **Generate new token (classic)** → scope `repo` → token ko
> password ki jagah paste karein.

✅ Repo par code dikhne lage = Step 1 done.

---

## Step 2 — Neon (database, free)

1. https://neon.com → **Sign up** (GitHub ya Google se — card nahi chahiye)
2. **Create project**
   - Name: `tablenest-db`
   - Region: **Singapore** (India ke sabse kareeb free region)
3. Dashboard → **Connect** → **Connection string**
   - ⚠️ **Pooled connection** wali string copy karein (host mein `-pooler` hota hai)
   - Aisi dikhegi:
     ```
     postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
     ```
4. Ye string kahin note kar lein — Step 4 mein chahiye.

> Database khud ban jayegi — tables/migrations app pehli baar chalne par bana dega.

---

## Step 2.5 — Purana data migrate karein (recommended)

Agar local SQLite mein restaurants / staff / QR tables already hain aur **wahi cloud par
chahiye** (same logins, same QR stickers), to Neon banne ke baad ye chalayein:

```bash
DATABASE_URL="postgresql://...-pooler...?sslmode=require" node scripts/sqlite-to-postgres.js
```

| Baat | Detail |
|---|---|
| IDs | Same rehte hain → staff logins aur QR tokens **nahi badalte** |
| Target | Khali hona chahiye; dobara chalane par `--truncate` lagayein |
| Test | `npm run test:migrate` (local embedded Postgres par verify) |
| Dry run | `--dry-run` se sirf count dikhta hai, kuch change nahi hota |

> Migration Render deploy se **pehle** ya **baad** — dono chalega. Pehle karein to pehla
> page load hi aapka data dikhayega.

---

## Step 3 — Render (app, free)

1. https://render.com → **Get Started** → **GitHub se sign up** (card nahi chahiye)
2. Render ko GitHub access dein → **Only select repositories** → `tablenest`
3. Dashboard → **New +** → **Blueprint**
4. Apna `tablenest` repo select karein → Render `render.yaml` padh kar service bana dega
   (Docker, free plan, Singapore region, health check `/api/health`)
5. **Apply** / **Create** dabayein

---

## Step 4 — Environment variables (sabse zaroori)

Blueprint banate waqt Render 4 values maangega (`sync: false` wale). Daal dein:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon ki **pooled** connection string |
| `JWT_SECRET` | niche diya hua 64-char secret |
| `VAPID_PUBLIC_KEY` | niche diya hua |
| `VAPID_PRIVATE_KEY` | niche diya hua |

Baaki (`NODE_ENV`, `DB_CLIENT`, `PGPOOL_MAX`, `VAPID_SUBJECT`) `render.yaml` se apne aap
set ho jayenge.

**Values kahan se?** Project folder ke `.env` se — ya naye banao:

```bash
node scripts/generate-vapid.js        # VAPID keys
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # JWT_SECRET
```

> ⚠️ **VAPID keys ek hi baar banao aur sambhal kar rakhein.** Ye badal gayi to har
> customer ko notifications dobara "Allow" karni padegi.

---

## Step 5 — Deploy verify

Render dashboard → apni service → **Logs**. Build 2–4 min lega. Aisa dikhna chahiye:

```
🚀 QRush running  (database: PostgreSQL)
```

Phir check karein:

| Check | Kahan |
|---|---|
| App khula? | `https://tablenest-xxxx.onrender.com` |
| Health | `.../api/health` → `{"ok":true,"name":"QRush"}` |
| DB | Logs mein `database: PostgreSQL` (SQLite nahi) |
| Signup | App par naya restaurant banayein |
| QR | Admin → Tables → QR — link **onrender.com** ka hona chahiye |
| Order | Customer menu → order → Kitchen screen live aaya? |
| Push | Kitchen/customer par "Allow notifications" |

> URL Render dashboard mein **service ke naam ke neeche** dikhta hai
> (e.g. `https://tablenest-a1b2.onrender.com`). Wahi QR ka base hai.

---

## Step 6 — App ko sone se rokna (free, recommended)

Free service 15 min idle par so jaati hai. Ek free cron se jagaye rakhein:

1. https://cron-job.org → **Sign up** (free)
2. **Create cronjob**
   - URL: `https://tablenest-xxxx.onrender.com/api/health`
   - Schedule: **every 10 minutes**
   - Save

Bas — ab app hamesha ready rahega. (Ye 750 instance-hours ke andar rehta hai; ek hi
free service rakhein, warna hours cross ho sakte hain.)

---

## Step 7 — Baad mein professional domain (optional, paid)

Jab app perfect ho jaye:

1. Domain kharidein (Cloudflare Registrar / GoDaddy — ~₹700–1200/saal)
2. Render → service → **Settings** → **Custom Domains** → **Add Custom Domain**
3. Render jo CNAME de, wo domain ke DNS mein daal dein
4. Render **SSL free** laga dega (kuch karna nahi)

> ✅ **QR codes automatic naye domain par chale jayenge** — `BASE_URL` set karne ki
> zaroorat nahi. Bas domain lagne ke **baad** QR stickers print karein.

---

## ❗ Common problems

| Problem | Solution |
|---|---|
| Build fail: `npm ci` | `package-lock.json` repo mein hona chahiye (hai ✅) |
| `Database connection failed` | `DATABASE_URL` **pooled** honi chahiye + `?sslmode=require` |
| SSL/certificate error | Env mein `PGSSL=no-verify` add karein, redeploy |
| App boot hua par login nahi | `NODE_ENV=production` + `JWT_SECRET` set hai? |
| QR purana link bana raha | `BASE_URL` env set hai to hata dein — QR request ke host se banta hai |
| Kitchen ko order nahi dikha | Ek hi instance chalna chahiye (free plan par default 1 hi hai) |
| Pehla request 50 sec | Normal — Step 6 ka cron laga dein |
| Push notification nahi | HTTPS ✅ + VAPID keys env mein ✅ — browser mein "Allow" dobara karein |

---

## 💰 Aage scale karne par

| Stage | Kya badlein | Cost |
|---|---|---|
| 1–2 restaurant (testing) | free plan + cron | ₹0 |
| 5–10 restaurant | Render paid instance (always-on) | ~$7/month |
| 10+ restaurant | Neon paid + custom domain | ~$15–20/month |
| Bahut zyada | Socket.IO Redis adapter + multiple instances | usage-based |
