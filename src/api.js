import {
  all,
  authenticateUser,
  createSession,
  createUser,
  ensureRootUser,
  first,
  getSessionUser,
  json,
  recordActivity,
  recordAudit,
  run,
  tokenFromRequest,
} from "./db.js";

const STATUSES = ["new", "site_built", "pitched", "replied", "won", "lost"];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTML_LIMIT = 100 * 1024;

class ApiError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function response(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

function fail(status, detail) {
  throw new ApiError(status, detail);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    fail(400, "Request body must be valid JSON.");
  }
}

function requireString(value, name, { min = 1, max = 1000 } = {}) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    fail(422, `${name} must be a string between ${min} and ${max} characters.`);
  }
  return value.trim();
}

function requireRoles(user, roles) {
  if (user.role === "root" || user.role === "admin" || roles.includes(user.role)) return;
  fail(403, `Access denied for role '${user.role}'.`);
}

async function currentUser(env, request) {
  const user = await getSessionUser(env, request);
  if (!user) fail(401, "Not authenticated.");
  return user;
}

async function audit(env, user, action, details, request) {
  await recordAudit(env, user, action, details, request.headers.get("CF-Connecting-IP"));
}

function normalizePhone(value) {
  if (typeof value !== "string") return null;
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0091") && digits.length === 14) digits = digits.slice(4);
  else if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return digits.length === 10 && /^[6789]/.test(digits) ? digits : null;
}

function slugify(name) {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  if (!slug) fail(400, "The business name has no readable Latin characters for a site URL.");
  return slug;
}

function validSlug(slug) {
  return typeof slug === "string" && slug.length <= 120 && SLUG_PATTERN.test(slug);
}

function publicUrl(request, path) {
  return new URL(path, request.url).toString();
}

async function upsertLeads(env, leads) {
  let added = 0;
  for (const lead of leads) {
    const phone = String(lead.phone || "").trim();
    const email = String(lead.email || "").trim();
    if (
      (lead.website || "").trim() ||
      !lead.place_id ||
      (phone && !normalizePhone(phone)) ||
      (!phone && !email)
    ) {
      continue;
    }
    const result = await run(
      env,
      `INSERT OR IGNORE INTO leads(
         place_id, name, phone, email, address, category, rating, reviews,
         website, lat, lng, raw
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      lead.place_id,
      lead.name ?? null,
      phone || null,
      email || null,
      lead.address ?? null,
      lead.category ?? null,
      lead.rating ?? null,
      lead.reviews ?? 0,
      lead.website ?? null,
      lead.lat ?? null,
      lead.lng ?? null,
      json(lead.raw),
    );
    if (result.meta?.changes) {
      added += 1;
      await recordActivity(env, lead.place_id, "lead_created", { source: "business_search" });
    }
  }
  return added;
}

async function searchBusinesses(env, input) {
  const query = requireString(input.query, "query", { max: 500 });
  const pages = Number(input.pages ?? 1);
  if (!Number.isInteger(pages) || pages < 1 || pages > 5) {
    fail(422, "pages must be an integer between 1 and 5.");
  }
  if (!env.SERPAPI_KEY) fail(503, "SERPAPI_KEY is not configured.");
  let scanned = 0;
  const leads = [];
  for (let page = 0; page < pages; page += 1) {
    const params = new URLSearchParams({
      engine: "google_maps",
      type: "search",
      q: query,
      start: String(page * 20),
      api_key: env.SERPAPI_KEY,
    });
    if (typeof input.ll === "string" && input.ll.trim()) params.set("ll", input.ll.trim());
    const result = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!result.ok) fail(502, `SerpAPI search failed (HTTP ${result.status}).`);
    const data = await result.json();
    if (data.error) fail(502, `SerpAPI search failed: ${data.error}`);
    const entries = data.local_results || [];
    if (!entries.length) break;
    scanned += entries.length;
    for (const item of entries) {
      const phone = (item.phone || "").trim();
      const email = (item.email || "").trim();
      if (
        (item.website || "").trim() ||
        !item.place_id ||
        (phone && !normalizePhone(phone)) ||
        (!phone && !email)
      ) {
        continue;
      }
      leads.push({
        place_id: item.place_id,
        name: item.title,
        phone: phone || null,
        email: email || null,
        address: item.address,
        category: item.type,
        rating: item.rating,
        reviews: item.reviews ?? 0,
        website: null,
        lat: item.gps_coordinates?.latitude,
        lng: item.gps_coordinates?.longitude,
        raw: item,
      });
    }
  }
  return { scanned, leads };
}

async function listLeads(env, request) {
  const leads = await all(
    env,
    `SELECT * FROM leads ORDER BY created_at DESC, place_id`,
  );
  const jobs = await all(
    env,
    `SELECT job_id, place_id, status, stage, progress, previous_slug,
            previous_storage
     FROM site_generation_jobs WHERE status IN ('queued', 'running')`,
  );
  const active = new Map(jobs.map((job) => [job.place_id, job]));
  return leads.map((lead) => {
    const job = active.get(lead.place_id);
    let publishedSlug = lead.site_slug;
    let publishedStorage = lead.site_storage;
    if (job?.previous_storage === "r2") {
      publishedSlug = job.previous_slug;
      publishedStorage = job.previous_storage;
    }
    const siteReady = Boolean(publishedSlug) && publishedStorage === "r2";
    const sitePath = siteReady ? `/site/${publishedSlug}` : null;
    const mobile = normalizePhone(lead.phone);
    return {
      ...lead,
      site_generation: job
        ? {
            job_id: job.job_id,
            status: job.status,
            stage: job.stage,
            progress: job.progress,
          }
        : null,
      site_ready: siteReady,
      whatsapp_phone: mobile ? `91${mobile}` : null,
      site_url: sitePath,
      site_public_url: sitePath ? publicUrl(request, sitePath) : null,
    };
  });
}

async function listR2Sites(env) {
  const sites = [];
  let cursor;
  do {
    const page = await env.SITES_BUCKET.list({ limit: 1000, cursor });
    for (const object of page.objects) {
      if (object.key.includes("/") || !object.key.endsWith(".html")) continue;
      const slug = object.key.slice(0, -5);
      if (validSlug(slug)) {
        sites.push({
          slug,
          size: object.size,
          last_modified: object.uploaded?.toISOString() ?? null,
        });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return sites;
}

async function enqueueSite(env, lead, request) {
  if (!env.SITE_JOBS) fail(503, "The site-generation queue is not configured.");
  const slug = slugify(lead.name || "");
  const previousSlug = lead.site_slug;
  const previousStorage = lead.site_storage;
  const currentOwnsSlug = previousSlug === slug && previousStorage === "r2";
  const owner = await first(env, "SELECT place_id FROM leads WHERE site_slug = ?", slug);
  if (owner && owner.place_id !== lead.place_id) fail(409, "A site with this business-name URL already exists.");
  if (!currentOwnsSlug && (await env.SITES_BUCKET.head(`${slug}.html`))) {
    fail(409, `The URL /site/${slug} is already in use; refusing to overwrite it.`);
  }

  const jobId = crypto.randomUUID().replaceAll("-", "");
  try {
    const batch = await env.DB.batch([
      env.DB.prepare(
        `UPDATE leads SET site_slug = ?
         WHERE place_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM leads other
             WHERE other.site_slug = ? AND other.place_id != ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM site_generation_jobs
             WHERE place_id = ? AND status IN ('queued', 'running')
           )
         RETURNING place_id`,
      ).bind(slug, lead.place_id, slug, lead.place_id, lead.place_id),
      env.DB.prepare(
        `INSERT INTO site_generation_jobs(
           job_id, place_id, slug, previous_slug, previous_storage,
           status, stage, progress, lead_data
         )
         SELECT ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?
         WHERE EXISTS (
           SELECT 1 FROM leads WHERE place_id = ? AND site_slug = ?
         )
           AND NOT EXISTS (
             SELECT 1 FROM site_generation_jobs
             WHERE place_id = ? AND status IN ('queued', 'running')
           )`,
      ).bind(
        jobId,
        lead.place_id,
        slug,
        previousSlug,
        previousStorage,
        json(lead),
        lead.place_id,
        slug,
        lead.place_id,
      ),
      env.DB.prepare(
        `INSERT INTO lead_activities(place_id, event_type, details)
         SELECT ?, 'site_generation_queued', ?
         WHERE EXISTS (SELECT 1 FROM site_generation_jobs WHERE job_id = ?)`,
      ).bind(lead.place_id, json({ job_id: jobId, slug }), jobId),
    ]);
    if (!batch[0].results?.length || !batch[1].meta?.changes) {
      fail(409, "A site generation is already active for this lead or its URL is in use.");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const active = await first(
      env,
      "SELECT job_id FROM site_generation_jobs WHERE place_id = ? AND status IN ('queued', 'running')",
      lead.place_id,
    );
    if (active) fail(409, "A site is already being generated for this lead.");
    throw error;
  }

  try {
    await env.SITE_JOBS.send({
      job_id: jobId,
      base_url: new URL(request.url).origin,
    });
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE leads SET site_slug = ?, site_storage = ?
         WHERE place_id = ? AND site_slug = ?`,
      ).bind(previousSlug, previousStorage, lead.place_id, slug),
      env.DB.prepare(
        `UPDATE site_generation_jobs
         SET status = 'failed', stage = 'Failed', error = ?,
             updated_at = datetime('now')
         WHERE job_id = ?`,
      ).bind("Unable to enqueue site generation.", jobId),
      env.DB.prepare(
        `INSERT INTO lead_activities(place_id, event_type, details)
         VALUES (?, 'site_generation_failed', ?)`,
      ).bind(lead.place_id, json({ job_id: jobId, error: "Unable to enqueue site generation." })),
    ]);
    console.error("Could not enqueue website generation", error);
    fail(503, "The site-generation queue is unavailable.");
  }
  return { job_id: jobId, status: "queued" };
}

async function editSiteHtml(env, slug, request, user) {
  if (!validSlug(slug)) fail(400, "Invalid generated site slug.");
  const input = await readJson(request);
  if (typeof input.html !== "string" || !input.html.trim()) {
    fail(422, "Site HTML cannot be empty.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.version || "")) {
    fail(422, "A valid site version is required.");
  }
  const bytes = new TextEncoder().encode(input.html);
  if (bytes.byteLength > HTML_LIMIT) fail(400, "Site HTML must be 100 KB or smaller.");
  if (!/<html\b/i.test(input.html) || !/<\/html\s*>/i.test(input.html)) {
    fail(400, "Site HTML must contain a complete <html> document.");
  }
  const current = await env.SITES_BUCKET.get(`${slug}.html`);
  if (!current) fail(404, "Site not found.");
  const currentBytes = await current.arrayBuffer();
  const currentVersion = [...new Uint8Array(await crypto.subtle.digest("SHA-256", currentBytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (currentVersion !== input.version) {
    fail(409, "This site changed after you opened it. Reload the latest HTML before saving.");
  }

  const version = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await env.SITES_BUCKET.put(`${slug}.html`, bytes, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache, must-revalidate",
    },
  });
  const owner = await first(env, "SELECT place_id FROM leads WHERE site_slug = ?", slug);
  await audit(env, user, "edit_site_html", { slug, bytes: bytes.byteLength, version }, request);
  if (owner) {
    await recordActivity(env, owner.place_id, "site_html_edited", {
      slug,
      user_email: user.email,
    });
  }
  return { slug, version, bytes: bytes.byteLength };
}

async function dispatchApi(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();
  const ip = request.headers.get("CF-Connecting-IP");

  if (method === "GET" && pathname === "/api/health") {
    return response({
      status: "healthy",
      d1: Boolean(env.DB),
      r2: Boolean(env.SITES_BUCKET),
      queue: Boolean(env.SITE_JOBS),
      timestamp: new Date().toISOString(),
    });
  }

  if ((method === "POST" && ["/api/auth/signup", "/api/auth/login"].includes(pathname))) {
    await ensureRootUser(env);
    const input = await readJson(request);
    const email = requireString(input.email, "email", { min: 3, max: 320 });
    const password = requireString(input.password, "password", { min: 6, max: 256 });
    let user;
    if (pathname.endsWith("/signup")) {
      try {
        user = await createUser(env, email, password);
      } catch (error) {
        if (/already registered/i.test(error.message)) fail(400, error.message);
        throw error;
      }
    } else {
      user = await authenticateUser(env, email, password);
      if (!user) fail(401, "Invalid email or password.");
    }
    const token = await createSession(env, user.id);
    await audit(env, user, pathname.endsWith("/signup") ? "user_signup" : "user_login", { role: user.role }, request);
    return response({ token, user });
  }

  if (pathname.startsWith("/api/")) {
    const user = await currentUser(env, request);

    if (method === "GET" && pathname === "/api/auth/me") return response(user);
    if (method === "POST" && pathname === "/api/auth/logout") {
      await run(env, "DELETE FROM sessions WHERE token = ?", tokenFromRequest(request));
      await audit(env, user, "user_logout", {}, request);
      return response({ ok: true });
    }

    if (pathname === "/api/admin/users" && method === "GET") {
      requireRoles(user, ["root", "admin"]);
      return response(await all(
        env,
        "SELECT id, email, role, created_at FROM users ORDER BY created_at DESC",
      ));
    }
    if (pathname === "/api/admin/activity-logs" && method === "GET") {
      requireRoles(user, ["root", "admin"]);
      const logs = await all(
        env,
        `SELECT id, user_id, user_email, action, details, ip_address, created_at
         FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 200`,
      );
      return response(logs.map((item) => ({ ...item, details: JSON.parse(item.details || "{}") })));
    }
    const adminRoute = pathname.match(/^\/api\/admin\/users\/([^/]+)(?:\/role)?$/);
    if (adminRoute) {
      requireRoles(user, ["root", "admin"]);
      const userId = decodeURIComponent(adminRoute[1]);
      const target = await first(env, "SELECT id, email, role FROM users WHERE id = ?", userId);
      if (!target) fail(404, "User not found.");
      if (method === "PATCH" && pathname.endsWith("/role")) {
        const input = await readJson(request);
        if (!["admin", "editor", "developer"].includes(input.role)) fail(422, "Invalid role.");
        if (userId === user.id) fail(400, "You cannot change your own role.");
        if (target.role === "root") fail(400, "Root user role cannot be changed.");
        if (input.role === "admin" && user.role !== "root") fail(403, "Only root can assign the admin role.");
        if (target.role === "admin" && user.role !== "root") fail(403, "Only root can modify admin users.");
        await run(env, "UPDATE users SET role = ? WHERE id = ?", input.role, userId);
        await audit(env, user, "change_user_role", { target_user_id: userId, new_role: input.role }, request);
        return response({ ok: true });
      }
      if (method === "PATCH" && !pathname.endsWith("/role")) {
        if (userId === user.id) fail(400, "Cannot edit your own account here.");
        if (target.role === "root" && user.role !== "root") fail(403, "Only root can edit the root user.");
        if (target.role === "admin" && user.role !== "root") fail(403, "Only root can edit admin users.");
        const input = await readJson(request);
        if (input.email !== undefined && input.email !== null) {
          const email = requireString(input.email, "email", { min: 3, max: 320 }).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(422, "Enter a valid email address.");
          if (await first(env, "SELECT id FROM users WHERE lower(email) = ? AND id != ?", email, userId)) {
            fail(400, "Email already in use.");
          }
          await run(env, "UPDATE users SET email = ? WHERE id = ?", email, userId);
        }
        if (input.password) {
          const password = requireString(input.password, "password", { min: 6, max: 256 });
          const salt = crypto.getRandomValues(new Uint8Array(16));
          const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
          const derived = new Uint8Array(await crypto.subtle.deriveBits(
            { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, material, 256,
          ));
          const hex = (value) => [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
          await run(
            env,
            "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
            hex(derived),
            hex(salt),
            userId,
          );
          await run(env, "DELETE FROM sessions WHERE user_id = ?", userId);
        }
        await audit(env, user, "edit_user", { target_user_id: userId }, request);
        return response({ ok: true });
      }
      if (method === "DELETE") {
        if (userId === user.id) fail(400, "You cannot delete your own account.");
        if (target.role === "root") fail(403, "Root user cannot be deleted.");
        if (target.role === "admin" && user.role !== "root") fail(403, "Only root can delete admin users.");
        await run(env, "DELETE FROM users WHERE id = ?", userId);
        await audit(env, user, "delete_user", { target_user_id: userId, email: target.email }, request);
        return response({ ok: true });
      }
    }

    if (method === "POST" && pathname === "/api/search") {
      requireRoles(user, ["editor"]);
      const input = await readJson(request);
      const result = await searchBusinesses(env, input);
      const added = await upsertLeads(env, result.leads);
      await audit(env, user, "search_leads", {
        query: input.query,
        found: result.leads.length,
        added,
      }, request);
      return response({ scanned: result.scanned, found: result.leads.length, added });
    }

    if (method === "GET" && pathname === "/api/leads") {
      await currentUser(env, request);
      return response(await listLeads(env, request));
    }
    if (method === "GET" && pathname === "/api/sites") {
      requireRoles(user, ["developer"]);
      const [storedSites, leads] = await Promise.all([
        listR2Sites(env),
        all(env, `SELECT site_slug, name, category, address, created_at
                  FROM leads WHERE site_storage = 'r2' AND site_slug IS NOT NULL`),
      ]);
      const metadata = new Map(leads.map((lead) => [lead.site_slug, lead]));
      storedSites.sort((a, b) => (b.last_modified || "").localeCompare(a.last_modified || ""));
      return response(storedSites.map((site) => {
        const lead = metadata.get(site.slug) || {};
        const path = `/site/${site.slug}`;
        return {
          ...site,
          name: lead.name || site.slug,
          category: lead.category ?? null,
          address: lead.address ?? null,
          created_at: lead.created_at ?? null,
          url: path,
          public_url: publicUrl(request, path),
        };
      }));
    }

    const siteHtmlRoute = pathname.match(/^\/api\/sites\/([^/]+)\/html$/);
    if (siteHtmlRoute) {
      requireRoles(user, ["developer"]);
      const slug = decodeURIComponent(siteHtmlRoute[1]);
      if (!validSlug(slug)) fail(400, "Invalid generated site slug.");
      if (method === "GET") {
        const object = await env.SITES_BUCKET.get(`${slug}.html`);
        if (!object) fail(404, "Site not found.");
        const html = await object.text();
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
        const version = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return response({ slug, html, version });
      }
      if (method === "PUT") return response(await editSiteHtml(env, slug, request, user));
    }

    if (method === "GET" && pathname.startsWith("/api/leads/") && pathname.endsWith("/activity")) {
      const id = decodeURIComponent(pathname.slice("/api/leads/".length, -"/activity".length));
      if (!(await first(env, "SELECT place_id FROM leads WHERE place_id = ?", id))) fail(404, "Lead not found.");
      const activities = await all(
        env,
        `SELECT activity_id, event_type, details, created_at
         FROM lead_activities WHERE place_id = ?
         ORDER BY created_at DESC, activity_id DESC LIMIT 100`,
        id,
      );
      return response(activities.map((activity) => ({
        ...activity,
        details: JSON.parse(activity.details || "{}"),
      })));
    }

    const jobRoute = pathname.match(/^\/api\/site-jobs\/([^/]+)$/);
    if (method === "GET" && jobRoute) {
      const job = await first(env, "SELECT * FROM site_generation_jobs WHERE job_id = ?", decodeURIComponent(jobRoute[1]));
      if (!job) fail(404, "Site generation job not found.");
      return response({
        job_id: job.job_id,
        place_id: job.place_id,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        url: job.site_url,
        error: job.error,
      });
    }

    const leadRoute = pathname.match(/^\/api\/leads\/([^/]+)$/);
    if (leadRoute) {
      const placeId = decodeURIComponent(leadRoute[1]);
      if (method === "PATCH") {
        requireRoles(user, ["editor"]);
        const old = await first(env, "SELECT * FROM leads WHERE place_id = ?", placeId);
        if (!old) fail(404, "Lead not found.");
        const input = await readJson(request);
        const allowed = ["name", "phone", "email", "address", "category", "rating", "reviews", "website", "status"];
        const fields = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)));
        if (Object.keys(fields).length !== Object.keys(input).length) fail(422, "Unsupported lead field.");
        if (fields.status !== undefined && !STATUSES.includes(fields.status)) fail(400, "Bad status.");
        if (fields.name !== undefined && fields.name !== null) {
          fields.name = requireString(fields.name, "name", { max: 200 });
        }
        if (fields.phone !== undefined && fields.phone !== null) fields.phone = requireString(fields.phone, "phone", { max: 100 });
        if (fields.email !== undefined && fields.email !== null) fields.email = requireString(fields.email, "email", { max: 320 });
        if (fields.address !== undefined && fields.address !== null) fields.address = requireString(fields.address, "address", { max: 500 });
        if (fields.category !== undefined && fields.category !== null) fields.category = requireString(fields.category, "category", { max: 200 });
        if (fields.website !== undefined && fields.website !== null) fields.website = requireString(fields.website, "website", { max: 2000 });
        if (fields.rating !== undefined && fields.rating !== null && (!Number.isFinite(fields.rating) || fields.rating < 0 || fields.rating > 5)) fail(422, "Rating must be between 0 and 5.");
        if (fields.reviews !== undefined && fields.reviews !== null && (!Number.isInteger(fields.reviews) || fields.reviews < 0)) fail(422, "Review count must be a non-negative integer.");
        const changed = Object.fromEntries(Object.entries(fields)
          .filter(([key, value]) => old[key] !== value && key !== "site_slug" && key !== "site_storage")
          .map(([key, value]) => [key, { from: old[key], to: value }]));
        const keys = Object.keys(fields);
        if (keys.length) {
          await run(
            env,
            `UPDATE leads SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE place_id = ?`,
            ...keys.map((key) => fields[key]),
            placeId,
          );
        }
        if (changed.status) {
          await recordActivity(env, placeId, "status_changed", { changes: { status: changed.status } });
        }
        const otherChanges = Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "status"));
        if (Object.keys(otherChanges).length) await recordActivity(env, placeId, "lead_updated", { changes: otherChanges });
        await audit(env, user, "update_lead", { place_id: placeId, fields }, request);
        return response({ ok: true });
      }
      if (method === "DELETE") {
        requireRoles(user, ["editor"]);
        const lead = await first(env, "SELECT * FROM leads WHERE place_id = ?", placeId);
        if (!lead) fail(404, "Lead not found.");
        const active = await first(
          env,
          `SELECT job_id FROM site_generation_jobs
           WHERE place_id = ? AND status IN ('queued', 'running')`,
          placeId,
        );
        if (active) fail(409, "Wait for site generation to finish before deleting this lead.");
        if (lead.site_storage === "r2" && lead.site_slug) await deleteR2Site(env, lead.site_slug);
        await run(env, "DELETE FROM leads WHERE place_id = ?", placeId);
        await audit(env, user, "delete_lead", { place_id: placeId, name: lead.name }, request);
        return response({ ok: true });
      }
    }

    const generateRoute = pathname.match(/^\/api\/leads\/([^/]+)\/site$/);
    if (method === "POST" && generateRoute) {
      requireRoles(user, ["developer"]);
      const lead = await first(env, "SELECT * FROM leads WHERE place_id = ?", decodeURIComponent(generateRoute[1]));
      if (!lead) fail(404, "Lead not found.");
      const result = await enqueueSite(env, lead, request);
      await audit(env, user, "generate_site", {
        place_id: lead.place_id,
        job_id: result.job_id,
        slug: slugify(lead.name || ""),
      }, request);
      return response(result, 202);
    }
  }

  return null;
}

export async function deleteR2Site(env, slug) {
  if (!validSlug(slug)) fail(400, "Invalid generated site slug.");
  let cursor;
  do {
    const page = await env.SITES_BUCKET.list({ prefix: `${slug}/`, limit: 1000, cursor });
    const keys = page.objects.map((object) => object.key);
    keys.push(...(cursor ? [] : [`${slug}.html`]));
    if (keys.length) await env.SITES_BUCKET.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function handleApi(request, env) {
  try {
    const result = await dispatchApi(request, env);
    if (result) return result;
    return response({ detail: "API route not found." }, 404);
  } catch (error) {
    if (error instanceof ApiError) return response({ detail: error.message }, error.status);
    if (error?.code === "ROOT_BOOTSTRAP_CONFIG") {
      return response({ detail: error.message }, 503);
    }
    console.error("Worker API request failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return response({ detail: "Internal server error." }, 500);
  }
}

export { all, first, json, recordActivity, recordAudit, run };
