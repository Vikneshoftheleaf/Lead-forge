import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { authenticateUser, ensureDefaultAccounts } from "../src/db.js";

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

test("user bootstrap requires all four strong account passwords", async () => {
  const env = {
    ROOT_PASSWORD: "a".repeat(20),
    EDITOR_PASSWORD: "b".repeat(20),
    DEVELOPER_PASSWORD: "c".repeat(20),
  };
  env.DB = {
    prepare() {
      return { bind() { return { first: async () => null }; } };
    },
  };
  const response = await worker.fetch(
    new Request("https://lead-forge.example/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", password: "password123" }),
    }),
    {
      ...env,
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    detail: "Set these GitHub/Worker password secrets to at least 16 characters: ADMIN_PASSWORD.",
  });
});

test("one-time bootstrap replaces all users and sessions with four fixed-role accounts", async () => {
  const statements = [];
  const env = {
    ROOT_PASSWORD: "r".repeat(24),
    EDITOR_PASSWORD: "e".repeat(24),
    DEVELOPER_PASSWORD: "d".repeat(24),
    ADMIN_PASSWORD: "a".repeat(24),
    DB: {
      prepare(sql) {
        return {
          sql,
          bind(...params) {
            return { sql, params, first: async () => null };
          },
        };
      },
      async batch(batch) {
        statements.push(...batch);
      },
    },
  };

  await ensureDefaultAccounts(env);

  assert.equal(statements.length, 7);
  assert.match(statements[0].sql, /DELETE FROM sessions/);
  assert.match(statements[1].sql, /DELETE FROM users/);
  const accountStatements = statements.filter((statement) => statement.sql.includes("INSERT INTO users"));
  assert.deepEqual(accountStatements.map((statement) => statement.params[1]), [
    "root@finsanta.com",
    "editor@finsanta.com",
    "developer@finsanta.com",
    "admin@finsanta.com",
  ]);
  assert.deepEqual(accountStatements.map((statement) => statement.params[4]), [
    "root",
    "editor",
    "developer",
    "admin",
  ]);
  assert.match(statements[6].sql, /INSERT OR IGNORE INTO app_settings/);
});

test("account bootstrap skips user reset after it has completed", async () => {
  let batches = 0;
  await ensureDefaultAccounts({
    DB: {
      prepare() {
        return { bind() { return { first: async () => ({ value: "done" }) }; } };
      },
      async batch() {
        batches += 1;
      },
    },
  });
  assert.equal(batches, 0);
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
    detail: "Public sign-up is disabled. Use one of the provisioned accounts.",
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
