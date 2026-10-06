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
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token used by Wrangler |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns the Worker and resources |
| `SERPAPI_KEY` | Google Maps lead search and business details |
| `GEMINI_API_KEY` | Website generation |
| `ROOT_EMAIL` | Email address for the initial root administrator |
| `ROOT_PASSWORD` | Initial root administrator password |
| `UNSPLASH_ACCESS_KEY` | Optional fallback photos when Maps photos are insufficient |

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
- Worker runtime secrets are provisioned from GitHub Secrets by the deployment workflow. Root credentials are not hard-coded; the configured root user is seeded on the first authentication request.

## Local Worker development

Use Node.js 22 or newer:

```bash
npm ci
Copy-Item .dev.vars.example .dev.vars
# Edit .dev.vars and set valid SERPAPI_KEY, GEMINI_API_KEY, ROOT_EMAIL,
# and ROOT_PASSWORD values.
npm run db:migrate:local
npm run dev
```

To deploy manually from a configured machine:

```bash
npm run db:migrate:remote
npm run deploy
```

`wrangler.toml` points to the project’s existing Cloudflare D1 ID and `sites` R2 bucket. If deploying to a different Cloudflare account, replace the D1 database ID and ensure the named R2 bucket and Queue exist in that account before deploying.
