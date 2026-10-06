# Lead Forge

Find Google Maps businesses with no website, manage them in a CRM, and generate bespoke static websites with Gemini.

## Deploy to Cloudflare Workers

The Cloudflare deployment runs the CRM, API, and generated-site hosting from a single Worker, using D1 for application data, R2 for published sites, and a Queue for background website generation. Pushes to `main` run tests, apply database migrations, publish the Worker and static assets, and synchronize Worker runtime settings through GitHub Actions. The four fixed-role accounts are provisioned directly in D1, separately from deployments; public sign-up is disabled. Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for setup.

## Run
```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # add SerpAPI, Gemini, and Cloudflare R2 credentials
uvicorn app.main:app --reload
```
Open http://localhost:8000

The commands above run the Python/FastAPI development backend. To develop against the Cloudflare Worker implementation locally, use the `Local Worker development` instructions in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Layout
- `app/serp.py` – SerpAPI Google Maps fetch, keeps listings with no `website`, no landline, and an Indian mobile number or email
- `app/db.py` – Python/FastAPI CRM database adapter
- `app/sitegen.py` – Gemini-generated website and atomic publication to Cloudflare R2
- `src/worker.js` – Cloudflare Worker entry point for the deployed CRM, API, and published websites
- `migrations/` – versioned Cloudflare D1 schema
- `static/index.html` – newest-first lead CRM with serial numbers, 10-lead pagination, gear-menu edit/delete actions, redesigned pipeline labels, background-generation progress, and Outreach links for published sites

Lead search rejects Indian landlines; phone contacts must be valid Indian mobile numbers, while an email address can qualify a listing with no phone. Existing leads remain below newly added leads. Outreach links require an Indian mobile number and a published site. Lead status keys remain compatible in storage while the CRM shows clearer labels: New lead, Site ready, Outreach sent, In conversation, Won, and Closed. The lead list supports text search, filters for status/site/contact, and sorting by newest, oldest, rating, review count, or business name.

Website generation runs as a durable background job, so status changes and other CRM actions remain available while a site is being built. Queued/running work and its input snapshot are stored in SQLite and requeued when the app starts after a restart. Up to three different leads can generate sites at the same time; additional requests are queued, and each lead can have only one active generation job. The CRM shows the current generation stage and progress and reports completion or errors without blocking the page. Per-lead activity history records lead creation, edits, status changes, and site generation outcomes.

Generated websites fetch Google Maps place details, opening hours, services, photos, and highly-rated reviews before Gemini 3.5 Flash designs and writes the complete page. Gemini receives the verified business data and reviews as text context and the selected photos as image inputs, so it can make an informed, distinct photo layout. Up to five verified Google Maps photos are preferred; if fewer than five are available, up to five Unsplash candidates are checked and only enough unique fallback photos are added to fill the remaining slots. Duplicate image content is removed, and a build is not published unless every selected image is used once, with verified local photo paths and the exact Google Maps embed and listing URLs. Generated pages use a responsive viewport and SEO title, text-only branding, desktop navigation links, and a simplified mobile navbar that shows only the business name and a direct CTA (Call, Email, or Directions); mobile navigation links and dropdowns are omitted. Before publishing, the build normalizes AI-generated navigation into this responsive structure and validates that desktop links are hidden on mobile and the mobile CTA is present. This can use up to three SerpAPI searches per generated site (place details, reviews, and photos). Set `SERPAPI_KEY`, `GEMINI_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in `.env`; `UNSPLASH_ACCESS_KEY` is optional. The private Cloudflare R2 bucket defaults to `sites` (`R2_BUCKET_NAME` can override it). Create an R2 S3 API token with object read, write, and delete permissions for that bucket. The app uses Cloudflare's S3-compatible endpoint derived from the account ID; set `R2_ENDPOINT_URL` only when using a custom S3-compatible endpoint.

Published HTML is stored as `{business-name}.html` in R2, with its photo assets under `{business-name}/`. The SEO-friendly slug is derived from the business name only: normalized to lowercase ASCII words joined with hyphens, with no locality, category, or generated ID appended. Visit each generated site at `/site/{business-name-slug}`; duplicate business-name slugs are rejected rather than overwritten. The app serves HTML and assets from the private bucket through same-domain routes; HTML is revalidated while photo assets use immutable caching. New builds are validated locally and their assets are uploaded before the HTML object is published. Each build makes exactly one Gemini generation request, with SDK retries and follow-up continuation requests disabled. A failed or truncated response is surfaced and not published; CDN and image-download failures are handled separately, and generated markup is locally repaired and validated before publishing. The one-call limit applies to Gemini generation; separate Maps/reviews/photo lookups and asset downloads remain necessary to prepare the business context and website. The `sites/` folder is not used to serve generated sites; `.site-builds/` is temporary build staging. Older sites previously generated to disk need to be regenerated to publish them to R2.

Each Gemini generation uses one randomly seeded request with a randomized temperature and a 16,384-token output limit. Generation does not retry failed requests, continue truncated responses, or switch to another model if unavailable or over quota.

The **Websites** workspace tab is available to root, admin, and developer users; editors cannot view or edit it. It lists published top-level HTML sites from R2 with business details, URL, file size, and last-modified time. Authorized users can edit a site's HTML directly and save it back to R2 without regenerating the site. Saves require the version loaded by the editor, so an intervening edit is reported as a conflict instead of silently overwriting newer HTML. The editor accepts complete HTML documents up to 100 KB and records successful edits in the audit log and the associated lead's activity history.
