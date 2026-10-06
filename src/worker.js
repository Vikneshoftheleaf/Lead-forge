import { handleApi } from "./api.js";
import { consumeSiteJobs } from "./site-generation.js";

function response(message, status) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function serveR2Site(request, env) {
  const pathname = new URL(request.url).pathname;
  const htmlMatch = pathname.match(/^\/site\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  const assetMatch = pathname.match(
    /^\/site-assets\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(photo-[a-f0-9]{8}\.(?:jpg|png|webp|gif))$/,
  );
  if (!htmlMatch && !assetMatch) return null;
  if (!env.SITES_BUCKET) return response("Site storage is unavailable.", 503);

  const slug = htmlMatch?.[1] || assetMatch[1];
  const key = htmlMatch ? `${slug}.html` : `${slug}/${assetMatch[2]}`;
  try {
    const object = await env.SITES_BUCKET.get(key);
    if (!object) return response("Not Found", 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    if (htmlMatch) {
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-cache, must-revalidate");
    } else {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    return new Response(object.body, { headers });
  } catch (error) {
    console.error("R2 site read failed", key, error);
    return response("Site storage request failed.", 502);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return handleApi(request, env);
    const site = await serveR2Site(request, env);
    if (site) return site;
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return response("Lead Forge Worker is running.", 200);
  },

  async queue(batch, env) {
    await consumeSiteJobs(batch, env);
  },
};
