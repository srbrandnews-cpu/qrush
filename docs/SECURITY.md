# QRUSH — Security Guide

Yeh document batata hai ki site par kaunsi security lagayi gayi hai, kya limits
hain, aur platform owner ko kya manually karna hai.

---

## 1. Ab kya protect hai (automatic)

### Response headers (har response par)
| Header | Value | Kya roktа hai |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Browser galat file type na samjhe |
| `X-Frame-Options` | `SAMEORIGIN` | Koi aur site aapki site ko iframe mein na dikha sake (clickjacking) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | URL ke secrets dusri site ko na jayein |
| `Permissions-Policy` | camera self, mic/geo/payment off | Browser features ka galat use |
| `Strict-Transport-Security` | 180 days | HTTPS force (sirf HTTPS requests par) |
| `Cross-Origin-Opener-Policy` | `same-origin` | Cross-window attacks |
| `X-Powered-By` | **removed** | Server technology leak nahi hoti |

### Rate limiting (per IP, in-memory)
| Endpoint | Limit |
|---|---|
| `POST /api/auth/login` | 10 attempts / 15 min |
| `POST /api/public/free-qr/login` | 15 / 15 min |
| `POST /api/public/free-qr/send-otp` | 5 / 15 min |
| `POST /api/public/free-qr/verify-otp` | 5 / 15 min |
| `POST /api/public/free-qr/reset-password` | 5 / 15 min |
| Har non-GET `/api/*` write | 120 / 5 min |
| Poore `/api/*` | 600 / min |

Limit cross hone par `429 Too Many Requests` + `Retry-After` header milta hai.
Server restart/redeploy par counters reset ho jate hain.

### Scanner / exploit paths blocked (404)
`.env`, `.git`, `.aws`, `.ssh`, `wp-admin`, `wp-login`, `phpmyadmin`, `vendor/`,
`config.php/.json/.yml`, `cgi-bin/`, `*.php`, `server-status`.

`TRACE` / `TRACK` methods bhi 405 se block hain.

### Server errors
Production (`NODE_ENV=production`) mein 5xx responses sirf `{ "error": "Server error" }`
bhejte hain. SQL/stack details sirf server logs mein jati hain — client ko nahi.

### Auth model (pehle se tha)
- Passwords `bcrypt` hash.
- JWT (12h staff, 180d free-QR owner) — `Authorization: Bearer`, cookie nahi.
- REST endpoints role-based (`requireAuth` / `requireRole` / `requireSuperAdmin`).
- Saare SQL queries parameterized (`?` / `$1`) — SQL injection ke liye raw concat nahi.
- Tenant isolation: har query `tenant_id` se scope hoti hai.
- Free-QR owner apna plan khud activate nahi kar sakta (401) — admin confirm zaroori.

---

## 2. ⚠️ Manual action — platform owner ke liye

### A. Database password rotate karein (urgent)
Purani file `reset_render.js` mein PostgreSQL ka password plain text tha aur woh
public GitHub repo mein commit ho chuki thi. File ab repo se hata di gayi hai,
lekin **password ko assume karein leaked**:

1. Render → PostgreSQL instance → **Settings / Connect**
2. **Rotate password** (ya naya credential generate karein)
3. Render → Web Service → **Environment** → `DATABASE_URL` update karein
4. Deploy ke baad health check: `/api/health`

> Password badalne se pehle app ka connection band ho sakta hai — isliye dono
> steps ek saath karein.

### B. Super Admin allowlist (production mein mandatory)
Production mein hard-coded demo admin **nahi** hai. Render → Environment mein set karein:

```
SUPER_ADMIN_EMAILS=owner@demo.com
```

(baad mein apna asli email daal dein, multiple admins comma se separate karein)

Iske bina `/superadmin` 403 dega — ye jaan-boojh kar kiya gaya hai taaki koi
default account se platform control na le sake.

### C. Passwords
Main website (Admin → Staff) archive ho chuki hai, isliye password change ka
purana page live nahi hai. Ab:

- **Free QR restaurant owner** — `free-qr.html → Owner Login → Forgot password`
  (registered phone par OTP aata hai).
- **Platform / Super Admin account** — iska password abhi UI se change nahi hota.
  Zaroorat pade to developer se DB-level reset karwayein (jab main website
  restore ho, Admin → Staff se bhi ho sakta hai).
- Purana `pass1234` password ab bhi kisi bhi account par active ho to boot logs
  mein `[SECURITY WARNING]` list dikhegi — us account ko turant secure karein.

### D. GitHub token revoke karein
https://github.com/settings/tokens → purana token → **Revoke**.

### E. Environment secrets check karein (Render → Environment)
- `JWT_SECRET` — lamba random (48+ chars). Badalne par sab users logout honge.
- `VAPID_PRIVATE_KEY` — push notifications ke liye; kho gaya to customers ko dobara allow karna padega.
- `DATABASE_URL` — kabhi logs ya chat mein share na karein.

### F. Super Admin settings
- WhatsApp number set karein (Settings tab).
- Ads toggle (`ad_enabled`) default **OFF** hai — jab restaurants badh jayein tab on karein.

---

## 3. Kya abhi bhi missing hai (future)

| Item | Note |
|---|---|
| Content-Security-Policy | Puri app inline scripts/styles use karti hai; CSP lagane se pehle nonce/hash migration chahiye. Abhi skip. |
| WAF / DDoS protection | Cloudflare free plan laga sakte hain (proxy already on hai — "Under Attack Mode" emergency ke liye). |
| 2FA for super admin | Recommended next step. |
| Audit log of logins | Abhi sirf subscription actions ka audit log hai. |
| Automated backups | `npm run backup:db` manually; Render Postgres ka daily backup plan check karein. |
| Socket.IO origin allowlist | Abhi permissive CORS hai (token-based auth, cookies nahi). Risk low. |

---

## 4. Limits change kaise karein

Sab limits `src/middleware/security.js` mein hain:

```js
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,  // time window
  max: 10,                   // requests allowed
  message: '...',
});
```

Numbers badal kar redeploy karein.

---

## 5. Incident checklist (agar hack ka shak ho)

1. Render → **Suspend** service (temporary).
2. DB password rotate + `JWT_SECRET` badlein (sab sessions invalid ho jayenge).
3. Render → Environment se koi bhi unknown variable hata dein.
4. Render → Events / Logs mein unknown deploys ya traffic dekhein.
5. DB mein naye users / tenants / payments check karein (Super Admin panel).
6. GitHub: unknown tokens revoke, 2FA on.
7. Backup se restore karein agar data tampered ho: `npm run restore:db`.
8. Incident ke baad `JWT_SECRET` dobara rotate karein (sab users re-login karenge).
