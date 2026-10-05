# Deploying Lead Forge to Cloudflare (Pages / Workers) & D1

This project is fully configured for Cloudflare's ecosystem:
- **Database**: Cloudflare D1 (`serpapi` database, ID: `6d21281f-8bf0-410d-9776-dc25691c7e8c`)
- **Generated Sites Storage**: Cloudflare R2 (`sites` bucket)
- **Frontend**: Cloudflare Pages (`static/`)
- **Backend**: FastAPI / Python

---

## 1. Cloudflare Pages (Frontend Deployment)

You can deploy the static frontend to Cloudflare Pages directly using Wrangler or Git integration.

### Method A: Deploy via Wrangler CLI
Run the following command from the project root:
```bash
npx wrangler pages deploy static --project-name lead-forge
```
*(On Windows cmd, you can also run `npm run deploy`)*

### Method B: Deploy via Cloudflare Dashboard (Git)
1. Push your repository to GitHub / GitLab.
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) > **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
3. Select this repository.
4. Build configuration:
   - **Framework preset**: `None`
   - **Build command**: *(leave blank)*
   - **Build output directory**: `static`
5. Click **Save and Deploy**.

---

## 2. Cloudflare D1 Management

Your D1 database is named `serpapi`.

- **View tables**:
  ```bash
  npx wrangler d1 execute serpapi --remote --command="SELECT name FROM sqlite_master WHERE type='table';"
  ```
- **Query leads**:
  ```bash
  npx wrangler d1 execute serpapi --remote --command="SELECT count(*), status FROM leads GROUP BY status;"
  ```
- **Re-run local migration** (if ever needed):
  ```bash
  python migrate_to_d1.py
  ```

---

## 3. Backend Deployment

Because the backend uses Python (FastAPI, Google GenAI SDK, SerpAPI, background job execution), you can deploy it on:

### Option A: Docker / VPS / Container Platform
```bash
docker compose up -d --build
```
Or deploy the `Dockerfile` to Render, Fly.io, Railway, or any Linux VPS / Cloudflare Tunnel.

### Option B: Local / Development
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
