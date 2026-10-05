# Lead Forge Deployment Guide

Lead Forge is deployed on Cloudflare with direct edge bindings to Cloudflare D1 and Cloudflare R2.

---

## 🌐 Live Cloudflare URLs

- **Live Cloudflare Worker & App**: [https://lead-forge.vikneshoftheleaf.workers.dev](https://lead-forge.vikneshoftheleaf.workers.dev)
- **Live Cloudflare Pages**: [https://lead-forge-dd1.pages.dev](https://lead-forge-dd1.pages.dev)
- **Health Check**: [https://lead-forge.vikneshoftheleaf.workers.dev/api/health](https://lead-forge.vikneshoftheleaf.workers.dev/api/health)

---

## 🚀 GitHub CI / Automated Deployments

When you push to GitHub, Cloudflare automatically runs:
```bash
npx wrangler deploy
```

This builds and publishes:
1. **[src/worker.js](file:///d:/7.%20Dev/lead-forge/src/worker.js)**: The Edge Worker entrypoint
2. **`static/`**: CRM Single Page Application assets
3. **`env.DB`**: Cloudflare D1 database (`serpapi`)
4. **`env.SITES_BUCKET`**: Cloudflare R2 bucket (`sites`)

---

## 💻 Manual Deployment Commands

To deploy anytime from your terminal:
```bash
# Deploy to Cloudflare Workers
npx wrangler deploy

# Deploy to Cloudflare Pages (Alternative)
npx wrangler pages deploy static --project-name lead-forge
```
