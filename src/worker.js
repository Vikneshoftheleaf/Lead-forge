/**
 * Lead Forge - Cloudflare Edge Worker Entrypoint
 * Handles static asset serving, Cloudflare D1 DB queries, and R2 static site hosting.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Serve generated sites directly from Cloudflare R2: /site/:slug or /site/:slug/photo.jpg
    if (pathname.startsWith("/site/")) {
      const rest = pathname.slice("/site/".length);
      if (!rest) {
        return new Response("Not Found", { status: 404 });
      }

      let r2Key;
      let contentType = "text/html; charset=utf-8";

      if (rest.includes("/")) {
        // Asset under site slug: e.g. "my-business/photo1.jpg"
        r2Key = rest;
        if (rest.endsWith(".jpg") || rest.endsWith(".jpeg")) contentType = "image/jpeg";
        else if (rest.endsWith(".png")) contentType = "image/png";
        else if (rest.endsWith(".webp")) contentType = "image/webp";
        else if (rest.endsWith(".css")) contentType = "text/css";
        else if (rest.endsWith(".js")) contentType = "application/javascript";
      } else {
        // Site HTML: e.g. "my-business" -> "my-business.html"
        r2Key = `${rest}.html`;
      }

      if (env.SITES_BUCKET) {
        try {
          const object = await env.SITES_BUCKET.get(r2Key);
          if (object) {
            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set("etag", object.httpEtag);
            headers.set("Content-Type", contentType);
            headers.set("Cache-Control", "public, max-age=3600");
            return new Response(object.body, { headers });
          }
        } catch (err) {
          return new Response(`Error fetching from storage: ${err.message}`, { status: 500 });
        }
      }
    }

    // 2. Health check endpoint
    if (pathname === "/api/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          d1: Boolean(env.DB),
          r2: Boolean(env.SITES_BUCKET),
          timestamp: new Date().toISOString()
        }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // 3. Fallback to serving static assets (CRM Frontend)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Lead Forge Worker is running.", {
      headers: { "Content-Type": "text/plain" }
    });
  }
};
