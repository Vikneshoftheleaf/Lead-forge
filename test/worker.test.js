import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { authenticateUser } from "../src/db.js";

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

test("login uses existing accounts and does not provision users from secrets", async () => {
  const preparedSql = [];
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", password: "password123" }),
    }),
    {
      DB: {
        prepare(sql) {
          preparedSql.push(sql);
          return { bind() { return { first: async () => null }; } };
        },
      },
    },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    detail: "Invalid email or password.",
  });
  assert.deepEqual(preparedSql, [
    "SELECT id, email, role, password_hash, salt FROM users WHERE lower(email) = ?",
  ]);
});

test("Worker password hashing matches the Python D1 password format", async () => {
  const password = "test-password-123456";
  const salt = "0123456789abcdef0123456789abcdef";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const digest = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 },
    key,
    256,
  ));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const user = await authenticateUser({
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => ({ id: "user-id", email: "root@finsanta.com", role: "root", password_hash: hash, salt }),
            };
          },
        };
      },
    },
  }, "ROOT@FINSANTA.COM", password);
  assert.equal(user?.email, "root@finsanta.com");
});

test("provisioned account can sign in without bootstrap secrets", async () => {
  const password = "root-login-test-123";
  const salt = "fedcba9876543210fedcba9876543210";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const digest = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 },
    key,
    256,
  ));
  const passwordHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const executedSql = [];
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ROOT@FINSANTA.COM", password }),
    }),
    {
      DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                first: async () => ({
                  id: "root-id",
                  email: "root@finsanta.com",
                  role: "root",
                  password_hash: passwordHash,
                  salt,
                }),
                run: async () => {
                  executedSql.push(sql);
                  return { meta: { changes: 1 } };
                },
              };
            },
          };
        },
      },
    },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.user.email, "root@finsanta.com");
  assert.equal(payload.user.role, "root");
  assert.ok(payload.token);
  assert.deepEqual(executedSql, [
    "INSERT INTO sessions(token, user_id) VALUES (?, ?)",
    "INSERT INTO audit_logs(user_id, user_email, action, details, ip_address)\n     VALUES (?, ?, ?, ?, ?)",
  ]);
});

test("public signup is disabled", async () => {
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "long-password" }),
    }),
    {},
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    detail: "Public sign-up is disabled. Use an account provisioned by the administrator.",
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
