import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function object(body, contentType) {
  return {
    body: new Response(body).body,
    httpEtag: '"test-etag"',
    writeHttpMetadata(headers) {
      headers.set("Content-Type", contentType);
    },
  };
}

test("health check reports configured Worker bindings", async () => {
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/health"),
    { DB: {}, SITES_BUCKET: {}, SITE_JOBS: {} },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "healthy");
  assert.equal(payload.d1, true);
  assert.equal(payload.r2, true);
  assert.equal(payload.queue, true);
  assert.equal(Number.isNaN(Date.parse(payload.timestamp)), false);
});

test("published site HTML is served from R2 without stale caching", async () => {
  const response = await worker.fetch(
    new Request("https://lead-forge.example/site/sunny-cafe"),
    {
      SITES_BUCKET: {
        get: async (key) => key === "sunny-cafe.html"
          ? object("<html>latest</html>", "text/html")
          : null,
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<html>latest</html>");
  assert.equal(response.headers.get("Cache-Control"), "no-cache, must-revalidate");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("site photo URLs map to the existing slug-scoped R2 object keys", async () => {
  let requestedKey;
  const response = await worker.fetch(
    new Request("https://lead-forge.example/site-assets/sunny-cafe/photo-1234abcd.jpg"),
    {
      SITES_BUCKET: {
        get: async (key) => {
          requestedKey = key;
          return object("photo bytes", "image/jpeg");
        },
      },
    },
  );
  assert.equal(requestedKey, "sunny-cafe/photo-1234abcd.jpg");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
});

test("site management API rejects unauthenticated requests", async () => {
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/sites"),
    {
      DB: {
        prepare() {
          return { bind() { return { first: async () => null }; } };
        },
      },
    },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "Not authenticated." });
});

test("auth works without bootstrap secrets after a root user exists", async () => {
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", password: "wrong-password" }),
    }),
    {
      DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                first: async () => sql.includes("WHERE role = 'root'")
                  ? { id: "root-id" }
                  : null,
              };
            },
          };
        },
      },
    },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "Invalid email or password." });
});

test("auth reports missing bootstrap secrets if no root exists", async () => {
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", password: "password123" }),
    }),
    {
      DB: {
        prepare() {
          return { bind() { return { first: async () => null }; } };
        },
      },
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    detail: "ROOT_EMAIL and ROOT_PASSWORD Worker secrets are required to create the initial root user.",
  });
});

test("websites API is available to every logged-in role except editors", async () => {
  for (const role of ["editor", "developer", "admin", "root"]) {
    const response = await worker.fetch(
      new Request("https://lead-forge.example/api/sites", {
        headers: { Authorization: "Bearer test-token" },
      }),
      {
        DB: {
          prepare(sql) {
            return {
              bind() {
                return {
                  first: async () => sql.includes("FROM sessions")
                    ? { id: "user-id", email: "user@example.com", role }
                    : null,
                  all: async () => ({ results: [] }),
                };
              },
            };
          },
        },
        SITES_BUCKET: {
          list: async () => ({ objects: [], truncated: false }),
        },
      },
    );
    assert.equal(response.status, role === "editor" ? 403 : 200, `${role} access`);
  }
});

test("unhandled requests fall through to static assets", async () => {
  const response = await worker.fetch(
    new Request("https://lead-forge.example/robots.txt"),
    { ASSETS: { fetch: async () => new Response("User-agent: *\nDisallow:\n") } },
  );
  assert.equal(await response.text(), "User-agent: *\nDisallow:\n");
});
