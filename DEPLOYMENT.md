# Deploy Lead Forge to Cloudflare Workers

Lead Forge deploys as one Cloudflare Worker: the Worker serves the CRM assets, provides the `/api/*` backend, reads and writes generated websites in R2, and queues long-running site generation. A push to `main` runs tests, applies D1 migrations, deploys the Worker, and updates its runtime secrets.

## Cloudflare resources

The Wrangler configuration uses:

- Worker: `lead-forge`
- D1 database: `serpapi` (the configured database ID is in `wrangler.toml`)
- R2 bucket: `sites`
- Queue: `lead-forge-site-jobs`

The configured D1 database and R2 bucket must exist in the Cloudflare account. Create the Queue once before the first push:

```bash
npx wrangler queues create lead-forge-site-jobs
```

Apply the schema manually if you want to provision it before CI:

```bash
npm ci
npm run db:migrate:remote
```

The GitHub deployment workflow applies migrations automatically on every deployment; D1 migration files are idempotent for existing Lead Forge tables.

## GitHub Actions setup

In the repository’s **Settings → Secrets and variables → Actions**, add these repository secrets:

| Secret | Purpose |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token used by Wrangler and the Python D1 adapter |
| `CF_ACCOUNT_ID` | Cloudflare account that owns the Worker and resources |
| `SERPAPI_KEY` | Google Maps lead search and business details |
| `GEMINI_API_KEY` | Website generation |
| `ROOT_PASSWORD` | Password for `root@finsanta.com` |
| `EDITOR_PASSWORD` | Password for `editor@finsanta.com` |
| `DEVELOPER_PASSWORD` | Password for `developer@finsanta.com` |
| `ADMIN_PASSWORD` | Password for `admin@finsanta.com` |
| `UNSPLASH_ACCESS_KEY` | Optional fallback photos when Maps photos are insufficient; removed from Worker when unset |
| `GEMINI_MODEL` | Optional Gemini model override; removed from Worker when unset |

All four account passwords must be at least 16 characters. Use distinct, randomly generated values and do not commit them. The workflow synchronizes every listed runtime secret to the Worker on each push; optional secrets are explicitly removed from the Worker when their GitHub secret is blank. `CF_API_TOKEN` and `CF_ACCOUNT_ID` are used by deployment tooling and are not sent to the Worker.
Remove the obsolete `ROOT_EMAIL` GitHub secret; account emails are now fixed in the application and are not configured as environment variables.

The API token needs **Workers Scripts: Edit**, **D1: Edit**, and **Queues: Edit** access for the target account. Keep the token and service keys in GitHub Secrets; do not add them to `wrangler.toml`, `.dev.vars.example`, or committed source.

After the Queue exists and the secrets are configured, push to `main` or run **Actions → Deploy Lead Forge to Cloudflare Workers → Run workflow**. The resulting app is available at:

- `https://lead-forge.<your-workers-subdomain>.workers.dev`
- Health check: `https://lead-forge.<your-workers-subdomain>.workers.dev/api/health`

To use a custom domain, attach it to the `lead-forge` Worker from **Cloudflare Dashboard → Workers & Pages → lead-forge → Settings → Domains & Routes**.

## Runtime behavior

- The Worker serves `static/` and routes API calls before static assets.
- D1 stores leads, users, sessions, audit logs, activities, and queued site-generation jobs.
- Queue consumers fetch business context, request one Gemini website generation, upload HTML and photos to R2, and update job progress in D1.
- Published sites are served at `/site/{slug}`; photo assets are served at `/site-assets/{slug}/{filename}`.
- The `Websites` tab and its HTML read/write endpoints are protected to root, admin, and developer roles. Editor users cannot access those endpoints.
- HTML responses are revalidated so a direct HTML edit is reflected without regenerating a site. Photo assets remain immutable and cacheable.
- Four fixed-role accounts are provisioned once on the first login after applying the account-bootstrap migration: `root@finsanta.com`, `editor@finsanta.com`, `developer@finsanta.com`, and `admin@finsanta.com`. That one-time bootstrap invalidates all old sessions and replaces all existing users with these four accounts. It uses the corresponding password secrets above. Public sign-up is disabled.
- To deliberately repeat the user reset after the bootstrap has run (for example, after rotating account passwords), first update all four GitHub password secrets and push so they reach the Worker. Then run `npx wrangler d1 execute serpapi --remote --command "DELETE FROM app_settings WHERE key = 'role_accounts_v1';"`. The next login re-seeds the four accounts and invalidates all sessions again.

## Local Worker development

Use Node.js 22 or newer:

```bash
npm ci
Copy-Item .dev.vars.example .dev.vars
# Edit .dev.vars and set valid service keys and four distinct account passwords.
npm run db:migrate:local
npm run dev
```

Local Worker authentication also provisions the four accounts once. The local D1 data is reset the first time login runs after the account-bootstrap migration.

For the Python/FastAPI development backend, add the same four password variables to `.env` along with the `CF_API_TOKEN`, `CF_ACCOUNT_ID`, and `CF_D1_DATABASE_ID` needed to access D1. Its first login performs the same one-time user/session reset. Give development its own D1 database ID; the Python backend connects to the remote D1 API and will otherwise reset the database selected by `.env`.

To deploy manually from a configured machine:

```bash
npm run db:migrate:remote
npm run deploy
```

`wrangler.toml` points to the project’s existing Cloudflare D1 ID and `sites` R2 bucket. If deploying to a different Cloudflare account, replace the D1 database ID and ensure the named R2 bucket and Queue exist in that account before deploying.
