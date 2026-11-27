# Deployment & release checklist

Professional, repeatable releases. Follow this order every time.

## Branches

| Branch | Deploys to | Purpose |
|---|---|---|
| `staging` | Render service from `render.staging.yaml` | Test new work with a **separate** Postgres DB |
| `main` | `https://www.qrush.in` (production) | Only after staging + checks pass |

Never experiment directly on production. (The one-time password reset endpoint
we used earlier was an exception forced by unavailable DB access; it was removed
immediately afterwards.)

## Local checks (required before every push)

```powershell
npm run verify       # syntax gate + end-to-end smoke test + npm audit
npm run predeploy    # clean worktree + no tracked secrets + printed checklist
```

`npm test` starts a throwaway server on a random port with a temporary SQLite
file, walks through signup → OTP → menu creation → owner edit → hosted menu,
then deletes everything. It never touches development or production data.

CI (`.github/workflows/ci.yml`) runs the same checks on every push to `main`
or `staging`, plus every pull request. A failing check blocks the release.

## Release steps

1. Work on a feature branch (or `staging`), run `npm run verify`.
2. Merge to `staging`, wait for Render, open the staging URL and check the
   changed screen on a phone browser.
3. Take a production DB backup:
   ```powershell
   npm run backup:db -- --out backups/pre-deploy-<date>.json
   ```
   (`DATABASE_URL` must be set in `.env`; see Render → Environment.)
4. Merge to `main`. Watch the Render deploy log and `/api/health`.
5. Verify the changed screens on `https://www.qrush.in`.
6. Tag the release and note it in `CHANGELOG.md`:
   ```powershell
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push --follow-tags
   ```

## Rollback

- **Code:** revert the offending commit on `main` and push; Render redeploys
  automatically.
- **Data:** only if a migration actually wrote bad data, restore from the JSON
  backup: `npm run restore:db -- backups/<file>.json`. Never restore a backup
  just because a deploy failed — schema migrations are additive and safe.

## Secrets / config

All configuration comes from environment variables (`.env.example` lists them).
Never commit `.env`, `.pem`, `.key` or a DB dump. Production values live in the
Render dashboard. `SUPER_ADMIN_EMAILS` must contain the email used to sign in
at `/superadmin`; without it, production console access is disabled by design.

## Known limitations (deliberate for this stage)

- OTP and rate-limit counters live in server memory. A single free-tier instance
  is fine; if we ever run multiple instances, move them to Postgres/Redis.
- A strict Content-Security-Policy is not enabled because several pages use
  inline scripts (JSON-LD, embed bootstrapping). XSS output escaping is in place.
- `archive/` contains old snapshots for reference. Do not edit them; they are
  not deployed.
