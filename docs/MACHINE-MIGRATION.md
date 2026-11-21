# Naya PC / Laptop par project shift karna (Recovery Guide)

Agar purana PC kharab ho jaye, to poora QRush project + ye chat history naye
machine par is guide se restore ho sakti hai. **Production (qrush.in) PC par
depend nahi karta** — wo Render par chalta hai.

---

## 1. Kya kahan hai (inventory)

| Cheez | Location | GitHub par? | Zaroori? |
|---|---|---|---|
| Poora code | `G:\hotel table booking` (git repo) | Haan, `main` branch | Haan |
| Env secrets | `G:\hotel table booking\.env` | **Nahi** (gitignored) | Haan (local dev ke liye) |
| Local SQLite DB | `G:\hotel table booking\data\tablenest.db` | Nahi | Sirf local testing |
| Backups | `G:\hotel table booking\backups\` | Nahi | Haan (cloud copy rakhein) |
| OpenCode chat history | `C:\Users\<user>\.local\share\opencode\opencode.db` | Nahi | Haan (agar chat chahiye) |
| OpenCode config | `C:\Users\<user>\.config\opencode\opencode.json` | Nahi | Haan (providers/settings) |
| OpenCode auth | OpenCode ke andar (encrypted) | Nahi | Haan (login) |
| Production env | Render Dashboard → qrush service → Environment | Nahi | Render par safe hai |
| Domain / DNS | GoDaddy | Nahi | Account login |

Production DB Render ke Postgres par hai — uski copy PC par nahi hoti.

---

## 2. Naye PC par software install karein

1. **Node.js LTS** (v20 ya v22) — https://nodejs.org
2. **Git for Windows** — https://git-scm.com
3. **OpenCode** — https://opencode.ai (installer ya `npm i -g @opencode/cli`)
4. (Optional) **VS Code**

Check karein:

```powershell
node -v
git --version
opencode --version
```

> PowerShell script block ho to: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

---

## 3. Code wapas laayein (2 minute)

```powershell
mkdir "G:\hotel table booking"
cd "G:\hotel table booking"
git clone git@github.com:srbrandnews-cpu/qrush.git .
npm install
```

GitHub par SSH key nahi hai to HTTPS use karein:

```powershell
git clone https://github.com/srbrandnews-cpu/qrush.git .
```

**Important:** folder ka path wahi rakhein — `G:\hotel table booking`. Chat
sessions isi absolute path se judi hain.

---

## 4. `.env` file wapas laayein

`.env` GitHub par nahi hai (security ke liye). Iski copy **USB drive** ya
**password manager** (Bitwarden/1Password/Google Password Manager note) mein
rakhein — WhatsApp/email par nahi.

Naya PC par:

```powershell
# .env ko project folder mein copy karein
copy D:\backup\.env "G:\hotel table booking\.env"
```

Sirf local dev ke liye chahiye. Kya-kya chahiye `.env.example` mein likha hai.

---

## 5. Chat history restore karein

### Option A — Sirf zaroori session (recommended, chhota)

Purane PC par (abhi, jab sab chalu hai):

```powershell
cd "G:\hotel table booking"
opencode session export ses_ea2c801b3ffe56lYSr0rjiXuFp > qrush-session.json
```

Naye PC par:

```powershell
cd "G:\hotel table booking"
opencode session import qrush-session.json --directory "G:\hotel table booking"
```

### Option B — Poora OpenCode data (sab projects, sab sessions)

Purane PC par OpenCode band karke:

```powershell
opencode service stop
```

Ye folder copy karein (USB/cloud):

```
C:\Users\<user>\.local\share\opencode\opencode.db
C:\Users\<user>\.local\share\opencode\opencode.db-wal
C:\Users\<user>\.local\share\opencode\opencode.db-shm
C:\Users\<user>\.config\opencode\opencode.json
C:\Users\<user>\.config\opencode\service.json
```

Naye PC par **same path** par paste karein, phir:

```powershell
opencode service restart
opencode session list
```

### Login dobara

```powershell
opencode auth list
opencode auth login        # provider choose karein
```

Ya purane PC se export/import (file mein secrets hote hain — safely handle karein):

```powershell
opencode auth export google > google-auth.json
opencode auth import google-auth.json
```

---

## 6. Local server chalayein

```powershell
cd "G:\hotel table booking"
$env:PORT="3115"
node server.js
```

Browser: http://localhost:3115

---

## 7. Production (qrush.in) — kuch nahi karna

- Site Render par chalti hai, PC se independent.
- Naya code live karna ho to: `git push origin main` → Render auto-deploy.
- Env variables Render Dashboard mein hain (`DATABASE_URL`, `JWT_SECRET`, etc.).
- `tablenest.onrender.com` service **delete na karein** — purane QR ka redirect usi se chalta hai.

---

## 8. Restore ke baad test checklist

- [ ] `http://localhost:3115` khulta hai
- [ ] `https://www.qrush.in/api/health` → `{"ok":true}`
- [ ] `https://www.qrush.in/robots.txt` → 200
- [ ] `https://www.qrush.in/sitemap.xml` → 200
- [ ] `https://www.qrush.in/m/723fd8e35eb5` → Hotel Shree Ganesh menu
- [ ] Local login (`9172941524` / local password) chalta hai
- [ ] QR generator se naya menu ban raha hai

---

## 9. Aadat bana lein (PC kharab hone se pehle)

1. **Roz/Hafte mein push:** `git add -A; git commit -m "..."; git push origin main`
2. **Hafte mein ek baar:** `.env` + `backups\` folder ka cloud copy
3. **OpenCode DB** ka copy: `backups\opencode-chat-<date>.db` (service band karke)
4. **Render** par DB ka manual backup/Neon snapshot (agar plan allow kare)
5. Domain/registrar (GoDaddy) ke login 2FA ke saath password manager mein
