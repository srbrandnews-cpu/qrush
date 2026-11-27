# Changelog

All notable changes to QRush are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-11-27

### Added
- CI workflow: syntax gate, end-to-end smoke test and dependency audit on every push/PR.
- `npm test` (throwaway DB + random port) and `npm run predeploy` release gate.
- Staging blueprint (`render.staging.yaml`) with a separate database.
- Release checklist in `docs/DEPLOY-CHECKLIST.md`.

### Changed
- Free-QR dashboard inline JavaScript extracted into six cacheable files under `public/js/`.
- Rate limiting now uses Cloudflare's authoritative client IP plus per-account buckets;
  auth routes reject bodies above 16 KB.

### Security
- Disabled phone-only password reset (any restaurant phone number is public).
  Forgot-password now routes to verified WhatsApp support, with a password reset action in the Super Admin console.
- Stopped returning OTPs for phone numbers that already have an account; OTP generation uses `crypto.randomInt`.
- Updated `body-parser` to 1.20.9 (`npm audit`: 0 vulnerabilities).
- Removed the temporary super-admin password reset endpoint.

## [1.0.0] - 2026-11-27

### Added
- Premium mobile customer menu: photos, search, category chips, gallery, languages.
- Animated welcome splash with restaurant-name voice (Web Speech API).
- Dish detail modal with photo, description, availability and half/full pricing.
- Owner dashboard: "Menu card / Dish list" tabs, add/paste dishes, auto photos, dish descriptions.
- Free QR SEO (sitemap, canonical tags), accessibility and security headers.

### Fixed
- Super admin console activation via `SUPER_ADMIN_EMAILS`; platform account creation/reset flow.
