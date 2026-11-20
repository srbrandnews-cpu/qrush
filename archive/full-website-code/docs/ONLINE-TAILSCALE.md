# 🌐 Online (permanent URL) — Tailscale Funnel

Ye setup **test ke liye** hai: free, koi card nahi, aur URL **hamesha same** rehta hai.

```
https://tablenest.tail0010e0.ts.net
```

| Screen | Link |
|---|---|
| Owner / Admin | `https://tablenest.tail0010e0.ts.net/admin` |
| Kitchen | `https://tablenest.tail0010e0.ts.net/kitchen` |
| Cashier | `https://tablenest.tail0010e0.ts.net/cashier` |
| Customer menu | `https://tablenest.tail0010e0.ts.net/menu?table=<table-token>` |

---

## 🚀 Roz kaise chalayein

**`start-online.bat` par double-click** — bas itna hi.

Ye script:
1. dependencies check karta hai,
2. Tailscale Funnel ko port 3000 par point karta hai,
3. server start karta hai,
4. browser kholta hai.

> ⚠️ **Laptop on rehna chahiye** aur ye window band nahi karni (minimize karein).
> App aapke laptop par hi chalta hai — internet par sirf ek secure tunnel se dikhta hai.

---

## 🔁 Reboot ke baad

- Tailscale **Windows service** hai → khud start ho jata hai.
- Funnel config **save** rehta hai.
- Bas `start-online.bat` double-click karein.

Agar server pehle se chal raha ho (port 3000 busy), window band karke dobara kholein.

---

## 📲 QR codes

QR code **automatically** isi URL ka banta hai — `BASE_URL` set karne ki zaroorat nahi.

Admin → **Tables & QR** → QR download/print. Link check karein ki
`https://tablenest.tail0010e0.ts.net/menu?table=...` hi hai.

---

## 🛠 Troubleshooting

| Problem | Solution |
|---|---|
| Site nahi khul rahi | `start-online.bat` chal raha hai? Laptop on hai? |
| `Funnel is not enabled` | https://console.tailscale.com/admin/acls → Funnel → Add Funnel to policy |
| URL khulta hai par 502 | Server band hai — `start-online.bat` dobara chalayein |
| Naya laptop / naya Tailscale account | URL badal jayega (`tablenest.<tailnet>.ts.net`) — `start-online.bat` aur docs update karein |
| QR purane link ka | `.env` mein `BASE_URL=` comment hona chahiye (script khud kar deta hai) |

---

## ⚠️ Limits (test ke liye theek hai)

- **Laptop on** hona zaroori — ye cloud host nahi hai.
- Tailscale free plan **non-commercial use** ke liye hai. Jab aap restaurants se
  paisa lena shuru karein, tab **Render paid** ya **apna domain + VPS** par shift karein
  (code same rahega, sirf host badlega).
- Internet speed par depend karta hai (customer ka page load aapke upload se hota hai).

---

## 🔜 Professional domain (baad mein)

Jab app perfect ho jaye:

1. Domain kharidein (₹700–1200/saal).
2. Render / VPS par deploy karein → `docs/FREE-DEPLOY.md` ya `docs/DOMAIN-SETUP.md`.
3. QR codes **khud** naye domain par chale jayenge — code change zero.
