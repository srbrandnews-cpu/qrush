# Archive — purani website ka code

Yeh folder **backup / baad mein use karne ke liye** hai.

> **Live setup:** purani website abhi **INACTIVE** hai (code safe hai, serve
> nahi hota). Sirf Free QR product live hai — `qrush.in` / `www.qrush.in`.
> `tablenest.onrender.com` par ek "Website inactive" page dikhta hai.
>
> Baad mein purani website chalu karne ke liye Render → Environment:
> `LEGACY_HOSTS=tablenest.onrender.com` (code change nahi chahiye).
>
> `archive/full-website-code/` isi code ka complete snapshot hai.

## Folders

### `full-website-code/`
**Poori purani website ka complete code snapshot** — commit `aba464e`
(2026-11-19), jab main website abhi live thi.

- 135 files · ~23.9 MB (isme 20 MB demo video bhi hai)
- Isme sab kuch hai: landing page, venue admin, kitchen, cashier, login,
  customer menu, waiting screen, **superadmin**, table/menu/order/request/voice
  APIs, auth, DB layer, socket, services, scripts, docs, deployment configs.
- Ye wahi code hai jo `https://tablenest.onrender.com` par chal raha tha.
- Demo video `public/video/qrush-demo.mp4` **local par hai lekin git mein nahi**
  (repo bhaari na ho). Naye PC par chahiye to purani git history se milega.

### `main-website/`
Live app se **actually hataye gaye** files ki copies + restore guide.

- `README.md` — kya hataya, kya shared/live hai, restore karne ke exact steps
- `MANIFEST.md` — file list + sizes

## Kya live hai ab

`qrush.in` par sirf **Free Digital QR Menu Generator**:

- `/` ya `/free-qr` — free QR landing + owner register/login
- `/m/:slug` — hosted QR menu
- `/m/:slug/kitchen` — free QR kitchen board
- `/superadmin` — platform console (Free QR plans, payments, revenue, ads)

## Data / database

- Database ko **delete ya modify nahi kiya gaya**.
- Purane tenants / tables / menu items / orders sab DB mein safe hain.
- Backup: `npm run backup:db`

## Restore

`main-website/README.md` ke "Restore kaise karein" section mein poore steps
hain (files copy + `server.js` routes + `package.json` scripts).
