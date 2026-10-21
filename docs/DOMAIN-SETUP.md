# 🌐 Domain + Permanent Tunnel Setup

**Kyun zaroori hai:** Quick tunnel ka URL har restart par badal jaata hai — matlab jo QR code aap
print karenge woh dead ho jayenge. Named tunnel se URL **permanent** ho jaata hai, aur aap har
restaurant ke liye ek hi QR sticker print karke zindagi bhar use kar sakte ho.

**Total cost:** Sirf domain ka kharcha (₹700–1200 / saal). Cloudflare tunnel **free** hai.

---

## Step 1 — Domain kharidein (₹700–1200/saal)

| Registrar | Price (approx) | Note |
|---|---|---|
| **Cloudflare Registrar** | cost price (no markup) | Cheapest, but Cloudflare account + DNS hi Cloudflare par hoga |
| GoDaddy | ₹800–1500 (first year cheap) | Sabse aasan, but DNS Cloudflare karenge |
| Namecheap / BigRock | ₹700–1000 | Yaad rakhein DNS Cloudflare karna hai |

> **Tip:** `.com` hamesha `.in` se mehnga hota hai. Chhote restaurant ke liye `.in` bhi bilkul
> chalega (`myhotel.in`).

---

## Step 2 — Domain ko Cloudflare par le aao (free)

1. **Cloudflare account** banayein → https://dash.cloudflare.com/sign-up
2. **Add a site** → apna domain daalein (`myhotel.in`)
3. Cloudflare do **nameservers** dikhayega (kuch aisa):
   ```
   anna.ns.cloudflare.com
   bob.ns.cloudflare.com
   ```
4. Apne registrar (GoDaddy/Namecheap) mein jaake **domain ke nameservers** badal dein
   Cloudflare wale par. (Registrar ka "Nameservers / DNS settings" section)
5. Save karein. **Propagation 5 min – 24 ghante** lag sakte hain. Check karne ke liye:
   ```bash
   nslookup myhotel.in
   ```
   Jab Cloudflare ka IP dikhe, tab aage badhein.

---

## Step 3 — Cloudflare Tunnel banao (free, 2 minute)

1. https://one.dash.cloudflare.com → pehli baar **team name** aur **plan (Free)** choose karein
2. Left menu → **Networks → Tunnels**
3. **Create a tunnel** → type `table-nest` → **Cloudflared** choose karein
4. Aapko ek **command** dikhegi usme ek lamba token hoga, jaise:
   ```
   cloudflared tunnel run --token eyJhIjoiXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ```
   👉 Sirf `--token` ke baad wala part copy karein (yeh **TUNNEL_TOKEN** hai)
5. Ab ek **Public Hostname** add karein:
   - **Subdomain:** `order`
   - **Domain:** `myhotel.in`
   - **Type:** HTTP
   - **URL:** `localhost:3000`
   - Save

   Ab aapka permanent URL ban gaya: **`https://order.myhotel.in`** 🎉

---

## Step 4 — TableNest ko batao (2 line)

Project ke `.env` file mein yeh do lines bhar dein:

```bash
TUNNEL_TOKEN=eyJhIjoiXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
PUBLIC_HOSTNAME=order.myhotel.in
```

> `BASE_URL` khud update ho jayega har start par — usko haath se chhedne ki zaroorat nahi.

---

## Step 5 — Chala dein

`start-tunnel.bat` par double-click karein (ya `npm run tunnel`).

Output mein aise dikhega:
```
Mode: NAMED tunnel (permanent URL) — order.myhotel.in
  ✅ Public URL   https://order.myhotel.in
  ✅ .env updated (BASE_URL)
  NOTE: yeh URL permanent hai — QR ek baar print karke zindagi bhar chalega.
```

---

## Step 6 — Verify

| Check | Kahan |
|---|---|
| Site khula? | https://order.myhotel.in |
| QR link sahi? | Admin → Tables & QR → menu link `order.myhotel.in` dikhna chahiye |
| Phone se khula? | Doosre phone se QR scan karein (bina same WiFi ke bhi chalega) |
| Push notification? | HTTPS hai toh browser push bhi chalega ✅ |

---

## 🎯 Ab QR print karein — permanently

Admin → **Tables & QR** → **Print all**. Jo QR print hoga woh **zindagi bhar** chalega,
chahe aap laptop restart karein.

Har restaurant ke liye alag QR hoga (alag table tokens), par **URL same** rahega —
matlab aap ek hi domain par saari restaurants chala sakte ho.

---

## 🔄 Aage badhte waqt (jab business badhe)

| Kab | Kya karein |
|---|---|
| Abhi (1-2 restaurant) | Named tunnel + domain ✅ (upar wala) |
| 5-10 restaurant | Same hi chalega — bas server VPS par shift kar dein |
| 10+ restaurant | VPS (₹500/mo) + Postgres + domain wahi rahega |

**VPS par shift karna ho toh:**
1. Ek VPS lein (DigitalOcean / Vultr Mumbai / Hetzner)
2. Node.js + Nginx install, `pm2` se app chalayein
3. `.env` mein `DB_CLIENT=postgres` + `DATABASE_URL=...`
4. SSL: Cloudflare par **Full (strict)** mode + origin certificate (free)

---

## ❓ Common problems

| Problem | Solution |
|---|---|
| Domain "unreachable" dikha | Nameservers propagate hone mein time lagta hai (24h max). `nslookup myhotel.in` se check karein |
| Tunnel "not connected" | `TUNNEL_TOKEN` copy karte waqt space/newline aa gaya hoga — `.env` mein paste karke save karein |
| `order.myhotel.in` par 502 | `localhost:3000` par server chal raha hona chahiye — `start-tunnel.bat` chalayein |
| Public hostname kaam nahi kar raha | Cloudflare dashboard → tunnel → Public Hostname → service `http://localhost:3000` (http, https nahi) |

---

## 💡 Quick tunnel vs Named tunnel

| | Quick (default) | Named (recommended) |
|---|---|---|
| Cost | Free | Free (sirf domain) |
| Account chahiye? | Nahi | Cloudflare account (free) |
| URL | Har restart par badalta hai | **Permanent** |
| QR codes | Reprint karne padenge | **Ek hi baar print** |
| Production ke liye | Nahi (Cloudflare terms) | Haan |
