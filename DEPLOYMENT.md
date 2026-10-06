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
| `CF_D1_DATABASE_ID` | D1 database used by the Python migration helper |
| `SERPAPI_KEY` | Google Maps lead search and business details |
| `GEMINI_API_KEY` | Website generation |
| `GEMINI_MODEL` | Gemini model override |
| `UNSPLASH_ACCESS_KEY` | Optional fallback photos when Maps photos are insufficient |
| `BASE_URL` | Python/FastAPI public origin |
| `R2_ACCOUNT_ID` | Python/FastAPI R2 S3 account identifier |
| `R2_ACCESS_KEY_ID` | Python/FastAPI R2 S3 access key |
| `R2_SECRET_ACCESS_KEY` | Python/FastAPI R2 S3 secret |
| `R2_BUCKET_NAME` | Python/FastAPI R2 bucket |
| `R2_ENDPOINT_URL` | Optional Python/FastAPI R2 S3 endpoint override |

GitHub Actions cannot read a local, gitignored `.env` file. Add the values there as GitHub Actions secrets with the same names; the workflow maps every `.env` variable into its deployment environment. The Worker receives only the service API keys and optional generation settings it uses. `CF_*` credentials are used by deployment tooling; `R2_*` credentials are for the separate Python backend, since the Worker uses native R2 bindings. Blank optional Worker secrets are removed during deployment.

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
- Four fixed-role accounts are provisioned directly in D1, separately from application startup and deployments: `root@finsanta.com`, `editor@finsanta.com`, `developer@finsanta.com`, and `admin@finsanta.com`. Passwords exist only as salted PBKDF2 hashes in D1; they are not stored in `.env`, GitHub Actions, or Worker secrets. Deployments never clear users or sessions. Public sign-up is enabled and always creates an `editor`; it cannot assign admin, developer, or root roles.

## Local Worker development

Use Node.js 22 or newer:

```bash
npm ci
Copy-Item .dev.vars.example .dev.vars
# Edit .dev.vars and set valid service API keys.
npm run db:migrate:local
npm run dev
```

Provision local Worker accounts separately in local D1. For the Python/FastAPI development backend, configure `.env` with `CF_API_TOKEN`, `CF_ACCOUNT_ID`, and a development `CF_D1_DATABASE_ID`; avoid pointing it at production unless intended.

To deploy manually from a configured machine:

```bash
npm run db:migrate:remote
npm run deploy
```

`wrangler.toml` points to the project’s existing Cloudflare D1 ID and `sites` R2 bucket. If deploying to a different Cloudflare account, replace the D1 database ID and ensure the named R2 bucket and Queue exist in that account before deploying.
