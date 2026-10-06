import { deleteR2Site, first, json, recordActivity, run } from "./api.js";

const MAX_PHOTO_BYTES = 700 * 1024;
const MAX_HTML_BYTES = 100 * 1024;
const MAPS_IMAGE_HOSTS = ["googleusercontent.com", "serpapi.com"];
const UNSPLASH_HOSTS = ["images.unsplash.com"];

function jsonError(data, service) {
  if (data.error) throw new Error(`${service} error: ${data.error}`);
}

async function serpSearch(env, params) {
  if (!env.SERPAPI_KEY) throw new Error("SERPAPI_KEY is not configured.");
  const url = new URL("https://serpapi.com/search.json");
  for (const [key, value] of Object.entries({ ...params, api_key: env.SERPAPI_KEY })) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SerpAPI request failed (HTTP ${response.status}).`);
  const data = await response.json();
  jsonError(data, "SerpAPI");
  return data;
}

function googleMapData(lead, listing) {
  const placeId = encodeURIComponent(lead.place_id);
  const coordinates = listing.gps_coordinates;
  const query = coordinates?.latitude != null && coordinates?.longitude != null
    ? `${coordinates.latitude},${coordinates.longitude}`
    : `place_id:${placeId}`;
  const embed = new URL("https://maps.google.com/maps");
  embed.searchParams.set("q", query);
  embed.searchParams.set("z", "16");
  embed.searchParams.set("output", "embed");
  const listingUrl = new URL("https://www.google.com/maps/search/");
  listingUrl.searchParams.set("api", "1");
  listingUrl.searchParams.set("query", [listing.title || lead.name, listing.address || lead.address].filter(Boolean).join(" "));
  listingUrl.searchParams.set("query_place_id", lead.place_id);
  return { embed: embed.toString(), listing: listingUrl.toString() };
}

function imageEntries(items) {
  const unique = new Map();
  for (const item of items || []) {
    const url = typeof item === "string"
      ? item
      : item?.thumbnail || item?.image || item?.original || item?.link;
    if (typeof url !== "string" || !url.startsWith("https://")) continue;
    const parsed = new URL(url);
    if (!MAPS_IMAGE_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) continue;
    if (!unique.has(url)) {
      unique.set(url, {
        url,
        attribution: typeof item === "object" ? (item.author || item.user?.name || "Google Maps") : "Google Maps",
        source: "Google Maps",
      });
    }
  }
  return [...unique.values()];
}

async function getBusinessContext(lead) {
  const [detailsResult, reviewsResult] = await Promise.all([
    serpSearch(lead.env, {
      engine: "google_maps",
      place_id: lead.place_id,
      hl: "en",
    }),
    serpSearch(lead.env, {
      engine: "google_maps_reviews",
      place_id: lead.place_id,
      sort_by: "ratingHigh",
      hl: "en",
    }).catch((error) => {
      console.warn("Google Maps reviews unavailable", lead.place_id, error);
      return {};
    }),
  ]);
  const listing = detailsResult.place_results;
  if (!listing) throw new Error("Google Maps returned no business details.");

  let photoItems = [...(listing.images || [])];
  const raw = typeof lead.raw === "string" ? JSON.parse(lead.raw || "{}") : (lead.raw || {});
  if (raw.thumbnail) photoItems.push(raw.thumbnail);
  if (listing.data_id) {
    try {
      const photos = await serpSearch(lead.env, {
        engine: "google_maps_photos",
        data_id: listing.data_id,
        hl: "en",
      });
      const results = photos.photos || photos.photos_results || [];
      photoItems = photoItems.concat(
        Array.isArray(results)
          ? results
          : Object.values(results).flatMap((value) => Array.isArray(value) ? value : []),
      );
    } catch (error) {
      console.warn("Google Maps photos unavailable", lead.place_id, error);
    }
  }
  const googlePhotos = imageEntries(photoItems);
  const reviewUrl = googleMapData(lead, listing).listing;
  const reviews = (reviewsResult.reviews || [])
    .map((review) => ({
      rating: Number(review.rating),
      text: review.snippet || review.extracted_snippet?.original,
      reviewer: review.user?.name || null,
      date: review.iso_date || review.date || null,
      url: review.link || reviewUrl,
    }))
    .filter((review) => review.rating >= 4 && review.text)
    .slice(0, 8);
  return {
    listing,
    reviews,
    photos: googlePhotos.slice(0, 8),
    map: googleMapData(lead, listing),
  };
}

async function unsplashCandidates(env, lead) {
  if (!env.UNSPLASH_ACCESS_KEY) return [];
  const query = [lead.category, lead.name, lead.address].filter(Boolean).join(" ");
  if (!query) return [];
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "5");
  url.searchParams.set("orientation", "landscape");
  const response = await fetch(url, {
    headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Unsplash request failed (HTTP ${response.status}).`);
  const data = await response.json();
  return (data.results || []).flatMap((photo) => {
    const photoUrl = photo.urls?.regular || photo.urls?.small;
    if (!photoUrl) return [];
    const parsed = new URL(photoUrl);
    if (!UNSPLASH_HOSTS.includes(parsed.hostname)) return [];
    return [{
      url: photoUrl,
      source: "Unsplash",
      attribution: photo.user?.name || "Unsplash contributor",
      credit_url: photo.user?.links?.html || "https://unsplash.com",
    }];
  });
}

async function getImageBytes(url) {
  const hostname = new URL(url).hostname;
  if (![...MAPS_IMAGE_HOSTS, ...UNSPLASH_HOSTS].some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  )) return null;
  const response = await fetch(url, {
    headers: { "Accept": "image/avif,image/webp,image/*" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/")) return null;
  const type = response.headers.get("content-type").split(";", 1)[0].toLowerCase();
  if (type === "image/svg+xml") return null;
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_PHOTO_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  const signatureValid = type === "image/jpeg"
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : type === "image/png"
      ? bytes[0] === 0x89 && new TextDecoder().decode(bytes.slice(1, 4)) === "PNG"
      : type === "image/webp"
        ? new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
        : type === "image/gif"
          ? ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6)))
          : false;
  if (!signatureValid) return null;
  return { bytes, type };
}

function base64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function collectPhotos(env, slug, candidates) {
  const selected = [];
  const uploaded = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (selected.length >= 5) break;
    try {
      const image = await getImageBytes(candidate.url);
      if (!image) continue;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", image.bytes));
      const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (seen.has(hash)) continue;
      seen.add(hash);
      const extension = image.type === "image/jpeg" ? "jpg" : image.type.split("/")[1];
      const filename = `photo-${crypto.randomUUID().slice(0, 8)}.${extension}`;
      const key = `${slug}/${filename}`;
      await env.SITES_BUCKET.put(key, image.bytes, {
        httpMetadata: { contentType: image.type, cacheControl: "public, max-age=31536000, immutable" },
      });
      uploaded.push(key);
      selected.push({
        filename,
        key,
        url: `/site-assets/${slug}/${filename}`,
        type: image.type,
        bytes: image.bytes,
        source: candidate.source,
        attribution: candidate.attribution,
        credit_url: candidate.credit_url || null,
      });
    } catch (error) {
      console.warn("Skipping a business photo", error);
    }
  }
  if (!selected.length) throw new Error("No verified business photos could be downloaded.");
  return { selected, uploaded };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function finalizeHtml(page, lead, listing, slug, map, photos, baseUrl) {
  let html = page.trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");
  const start = html.search(/<!doctype\s+html|<html\b/i);
  if (start >= 0) html = html.slice(start);
  if (!/<html\b/i.test(html) || !/<\/html\s*>/i.test(html) || !/<head\b/i.test(html) || !/<body\b/i.test(html)) {
    throw new Error("Gemini did not return a complete HTML document.");
  }
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("Generated website is larger than 100 KB.");
  if (!html.includes(map.embed)) throw new Error("Generated site omitted the verified Google Maps embed.");
  for (const photo of photos) {
    if (!html.includes(photo.url)) throw new Error("Generated site omitted one of its verified local photos.");
  }
  const title = `${listing.title || lead.name} | ${listing.type || lead.category || "Business"}`;
  const city = listing.address || lead.address || "";
  const description = `${listing.title || lead.name}${listing.type ? ` - ${listing.type}` : ""}${city ? ` in ${city}` : ""}`.slice(0, 160);
  const titleTag = `<title>${escapeHtml(title.slice(0, 65))}</title>`;
  if (/<title\b[^>]*>.*?<\/title\s*>/i.test(html)) {
    html = html.replace(/<title\b[^>]*>.*?<\/title\s*>/i, titleTag);
  } else {
    html = html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${titleTag}`);
  }
  if (!/<meta\b[^>]*\bname\s*=\s*["']?viewport/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, (tag) => `${tag}<meta name="viewport" content="width=device-width, initial-scale=1">`);
  }
  const metadata = `<meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(new URL(`/site/${slug}`, baseUrl).toString())}">`;
  html = html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${metadata}<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" defer></script>`);
  return html;
}

async function generatePage(env, lead, slug, context, photos, baseUrl) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
  const listing = context.listing;
  const photoContext = photos.map((photo) => ({
    url: photo.url,
    source: photo.source,
    attribution: photo.attribution,
    credit_url: photo.credit_url || null,
  }));
  const prompt = `Create a distinctive, responsive, production-quality single-page HTML website for this business. Use Tailwind utility classes from the browser CDN. Return only a complete HTML document. Never invent facts; use only the supplied context. Include a viewport meta tag, a descriptive title, a semantic h1, simple mobile-first navigation, the exact Google Maps iframe URL, and each supplied local image URL once with descriptive alt text. Do not add scripts other than the Tailwind CDN, external images, inline CSS, forms, or other iframes. Reviews must be exact supplied excerpts.

Business data:
${JSON.stringify({
    lead: {
      name: lead.name,
      category: lead.category,
      address: lead.address,
      phone: lead.phone,
      email: lead.email,
      rating: lead.rating,
      review_count: lead.reviews,
    },
    verified_listing: listing,
    positive_reviews: context.reviews,
    photos: photoContext,
    google_maps: context.map,
  })}`;

  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const parts = [{ text: prompt }];
  for (const photo of photos) {
    parts.push({
      inlineData: { mimeType: photo.type, data: base64(photo.bytes) },
    });
  }
  const result = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 12_000,
          responseMimeType: "text/plain",
        },
        systemInstruction: {
          parts: [{ text: "You are an expert web designer. Return only a complete HTML document, grounded only in supplied business data." }],
        },
      }),
      signal: AbortSignal.timeout(240_000),
    },
  );
  const data = await result.json();
  if (!result.ok) throw new Error(`Gemini request failed (HTTP ${result.status}): ${data.error?.message || "unknown error"}`);
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") throw new Error("Gemini reached the output limit; no incomplete site was published.");
  const html = candidate?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!html) throw new Error("Gemini returned an empty website.");
  return finalizeHtml(html, lead, listing, slug, context.map, photos, baseUrl);
}

async function cleanupUploaded(env, keys) {
  if (!keys.length) return;
  try {
    await env.SITES_BUCKET.delete(keys);
  } catch (error) {
    console.error("Could not clean up failed site assets", error);
  }
}

async function cleanupStaleAssets(env, slug, photos) {
  const keep = new Set(photos.map((photo) => photo.key));
  try {
    let cursor;
    do {
      const page = await env.SITES_BUCKET.list({ prefix: `${slug}/`, limit: 1000, cursor });
      const stale = page.objects.map((item) => item.key).filter((key) => !keep.has(key));
      if (stale.length) await env.SITES_BUCKET.delete(stale);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    console.error(`Could not clean up outdated assets for ${slug}`, error);
  }
}

async function buildAndPublish(env, lead, slug, baseUrl, progress) {
  const context = await getBusinessContext({ ...lead, env });
  await progress("Preparing verified business photos", 24);
  let candidates = context.photos;
  if (candidates.length < 5) {
    try {
      candidates = candidates.concat(await unsplashCandidates(env, lead));
    } catch (error) {
      console.warn("Unsplash fallback photos unavailable", error);
    }
  }
  let uploaded = [];
  try {
    const collected = await collectPhotos(env, slug, candidates);
    const photos = collected.selected;
    uploaded = collected.uploaded;
    await progress("Generating website with Gemini", 48);
    const html = await generatePage(env, lead, slug, context, photos, baseUrl);
    await progress("Publishing website and photos", 90);
    await env.SITES_BUCKET.put(`${slug}.html`, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8", cacheControl: "no-cache, must-revalidate" },
    });
    await cleanupStaleAssets(env, slug, photos);
  } catch (error) {
    await cleanupUploaded(env, uploaded);
    throw error;
  }
  return slug;
}

export async function consumeSiteJobs(batch, env) {
  for (const message of batch.messages) {
    const { job_id: jobId, base_url: baseUrl } = message.body || {};
    let job;
    let claimAcquired = false;
    try {
      if (!jobId) throw new Error("Queue message did not include a site job id.");
      const claim = await run(
        env,
        `INSERT INTO site_generation_claims(job_id, lease_until)
         VALUES (?, datetime('now', '+14 minutes'))
         ON CONFLICT(job_id) DO UPDATE SET lease_until = excluded.lease_until
         WHERE datetime(site_generation_claims.lease_until) < datetime('now')`,
        jobId,
      );
      if (!claim.meta?.changes) {
        message.ack();
        continue;
      }
      claimAcquired = true;
      job = await first(env, "SELECT * FROM site_generation_jobs WHERE job_id = ?", jobId);
      if (!job || job.status === "completed" || job.status === "failed") {
        message.ack();
        continue;
      }
      const lead = JSON.parse(job.lead_data || "{}");
      if (!lead.place_id || lead.place_id !== job.place_id) throw new Error("Site job lead snapshot is invalid.");
      await run(
        env,
        `UPDATE site_generation_jobs
         SET status = 'running', stage = 'Fetching business details and reviews',
             progress = 8, error = NULL, updated_at = datetime('now')
         WHERE job_id = ?`,
        jobId,
      );
      await recordActivity(env, job.place_id, "site_generation_started", {});
      const slug = await buildAndPublish(
        env,
        lead,
        job.slug,
        baseUrl || "https://lead-forge.workers.dev",
        async (stage, progress) => {
          await run(
            env,
            `UPDATE site_generation_jobs
             SET stage = ?, progress = ?, updated_at = datetime('now')
             WHERE job_id = ? AND status = 'running'`,
            stage,
            progress,
            jobId,
          );
        },
      );
      const previous = await first(env, "SELECT status FROM leads WHERE place_id = ?", job.place_id);
      if (!previous) throw new Error("Lead was removed before generation completed.");
      const completion = [
        env.DB.prepare(
          `UPDATE leads SET site_slug = ?, site_storage = 'r2',
             status = CASE WHEN status = 'new' THEN 'site_built' ELSE status END
           WHERE place_id = ?`,
        ).bind(slug, job.place_id),
        env.DB.prepare(
          `UPDATE site_generation_jobs
           SET status = 'completed', stage = 'Published', progress = 100,
               site_url = ?, error = NULL, updated_at = datetime('now')
           WHERE job_id = ?`,
        ).bind(`/site/${slug}`, jobId),
        env.DB.prepare(
          `INSERT INTO lead_activities(place_id, event_type, details)
           VALUES (?, 'site_generation_completed', ?)`,
        ).bind(job.place_id, json({ slug })),
      ];
      if (previous.status === "new") {
        completion.splice(2, 0, env.DB.prepare(
          `INSERT INTO lead_activities(place_id, event_type, details)
           VALUES (?, 'status_changed', ?)`,
        ).bind(job.place_id, json({ changes: { status: { from: "new", to: "site_built" } } })));
      }
      await env.DB.batch(completion);
      if (job.previous_slug && job.previous_slug !== slug && job.previous_storage === "r2") {
        await deleteR2Site(env, job.previous_slug);
      }
    } catch (error) {
      console.error(`Website generation failed for job ${jobId || "unknown"}`, error);
      if (job) {
        const detail = String(error?.message || "Website generation failed.").slice(0, 1000);
        try {
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE leads SET site_slug = ?, site_storage = ?
               WHERE place_id = ? AND site_slug = ?`,
            ).bind(job.previous_slug, job.previous_storage, job.place_id, job.slug),
            env.DB.prepare(
              `UPDATE site_generation_jobs
               SET status = 'failed', stage = 'Failed', error = ?,
                   updated_at = datetime('now')
               WHERE job_id = ?`,
            ).bind(detail, jobId),
            env.DB.prepare(
              `INSERT INTO lead_activities(place_id, event_type, details)
               VALUES (?, 'site_generation_failed', ?)`,
            ).bind(job.place_id, json({ job_id: jobId, error: detail })),
          ]);
        } catch (recordError) {
          console.error("Could not record website generation failure", recordError);
        }
      }
    } finally {
      if (claimAcquired) {
        try {
          await run(env, "DELETE FROM site_generation_claims WHERE job_id = ?", jobId);
        } catch (error) {
          console.error("Could not release site generation claim", jobId, error);
        }
      }
    }
    message.ack();
  }
}
