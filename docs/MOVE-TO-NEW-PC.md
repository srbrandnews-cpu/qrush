# Naye PC par project shift karna (PC kharab ho jaye to)

Yeh guide batati hai ki QRush ka **code, data, secrets aur AI chat history** naye computer par kaise laayein.

---

## 1. Kya kahan rehta hai

| Cheez | Kahan | Naye PC par chahiye? |
|---|---|---|
| **Code** | GitLab → `tablenest/tablenest` (branch `main`) | ✅ Clone karo |
| **Live data** (restaurants, orders, menus, users) | **Neon Postgres** (cloud) | ❌ Kuch nahi — cloud me safe hai |
| **Secrets** (`JWT_SECRET`, `DATABASE_URL`, VAPID keys) | Render → Environment (git me nahi) | ✅ Password manager me save karo |
| **Local test DB** | `data/tablenest.db` (sirf is PC par) | Optional |
| **AI chat history (OpenCode)** | `C:\Users\DELL\.local\share\opencode\opencode.db` | ✅ Copy karo |
| **Uploaded menu images / logo** | Database ke andar (data URI) | Cloud me safe |
| **Demo video** | `public/video/qrush-demo.mp4` (git me) | ✅ Clone se aa jayegi |

> **Important:** PC kharab hone par live website band nahi hogi — Render (server) aur Neon (database) dono alag cloud services hain.

---

## 2. Naye PC par project chalana (10 minute)

1. Install karo:
   - **Git** → https://git-scm.com/download/win
   - **Node.js 24 LTS** → https://nodejs.org
   - **Google Chrome** (screenshots/testing ke liye)
2. Command Prompt / PowerShell kholo aur clone karo:
   ```powershell
   cd G:\
   git clone https://gitlab.com/tablenest/tablenest.git "hotel table booking"
   cd "G:\hotel table booking"
   npm install
   ```
3. `.env` file banao (`G:\hotel table booking\.env`) — values password manager / Render se lo:
   ```env
   PORT=3000
   JWT_SECRET=<wahi purana secret — nahi to sare logins logout ho jayenge>
   VAPID_SUBJECT=mailto:support@tablenest.app
   VAPID_PUBLIC_KEY=<Render se>
   VAPID_PRIVATE_KEY=<Render se>
   DB_CLIENT=sqlite
   ```
4. Start:
   ```powershell
   npm start
   ```
   Open: http://localhost:3000

### Live data local par chalana ho (optional)
`.env` me yeh add karo:
```env
DB_CLIENT=postgres
DATABASE_URL=<Render → Environment → DATABASE_URL>
DNS_SERVERS=8.8.8.8,1.1.1.1
```
`DNS_SERVERS` sirf tab chahiye jab `getaddrinfo ENOTFOUND` aaye.

⚠️ Is mode me local se kiya gaya change **seedha live data** me jayega. Sirf dekhne ke liye use karo.

---

## 3. AI chat history (OpenCode) naye PC par

Chat history local file me hoti hai, isliye usse alag se copy karna padta hai:

**Purane PC par (OpenCode band karke):**
1. OpenCode / is app ko poora band karo (system tray se bhi).
2. Yeh folder copy karo (pen drive / Google Drive):
   - `C:\Users\DELL\.local\share\opencode` → `opencode.db`, `opencode.db-wal`, `opencode.db-shm`
   - `C:\Users\DELL\.config\opencode` (settings)
   - `C:\Users\DELL\.local\state\opencode` (model + prompt history)

**Naye PC par:**
1. OpenCode install karo, ek baar kholo, phir **band** karo.
2. Upar wale teen folders ko **same path** par paste karo (naya username ho to `C:\Users\<naya-user>\...`).
3. Project ko **same folder path** par clone karo (`G:\hotel table booking`) — chat sessions usi directory se judi hoti hain.
4. OpenCode kholo → purani chats wapas mil jayengi.

> `opencode.db` approx 180 MB ki hai. Copy karte waqt OpenCode band hona zaroori hai, warna database corrupt ho sakta hai.

**Aasaan tarika — ek command se chat snapshot:**
```powershell
cd "G:\hotel table booking"
npm run backup:chat
```
Yeh `backups\opencode-chat-<date>.db` bana deta hai aur OpenCode khula ho tab bhi safe hai. Naye PC par is file ka naam `opencode.db` rakh kar `%USERPROFILE%\.local\share\opencode\` me rakh do (OpenCode band karke).

⚠️ Is file me aapke provider/API credentials bhi hote hain — isse public ya GitLab par upload mat karo.

---

## 4. Database backup (recommended — hafte me ek baar)

Production database ki full JSON copy:

```powershell
cd "G:\hotel table booking"
$env:DATABASE_URL="postgresql://...";    # Render → Environment se
npm run backup:db
```

- File banti hai: `backups/tablenest-<date>.json`
- Is file ko **Google Drive / pen drive** par bhi rakho.
- Restore (naye/khali database me):
  ```powershell
  npm run restore:db -- backups/tablenest-2026-....json --fresh
  ```

**Neon ka apna restore:** https://console.neon.tech → project → **Backups / Branches** → point-in-time restore. Free plan me bhi kuch hours ka history milta hai.

---

## 5. Agar PC kal kharab ho jaye — checklist

1. ✅ Live site check karo: https://tablenest.onrender.com — chal rahi hogi.
2. Naya PC → Git + Node install → repo clone → `npm install`.
3. `.env` banao (secrets password manager se).
4. `npm start` → local par kaam shuru.
5. Chat continue karni ho → OpenCode folder copy karo (section 3).
6. Data kisi wajah se lost ho → Neon restore ya `npm run restore:db`.

**Yeh cheezein safe rakhna zaroori hai:**
- GitLab account ka password / recovery email
- Render account ka login
- Neon account ka login
- `JWT_SECRET`, `DATABASE_URL`, VAPID keys (password manager me)
- `backups/` folder ki latest file (Google Drive par)

---

## 6. Free-tier reminders

- **Render** free service 15 min inactivity par sleep hoti hai — GitLab scheduled pipeline (`*/14 * * * *`) usse awake rakhti hai.
- **Neon** free DB bhi idle hone par suspend hoti hai, par data safe rehta hai; pehli query par 1–2 sec lag sakta hai.
