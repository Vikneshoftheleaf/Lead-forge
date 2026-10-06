const PASSWORD_ITERATIONS = 100_000;
const encoder = new TextEncoder();

export function all(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).all().then((result) => result.results || []);
}

export function first(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}

export function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

export function json(value) {
  return JSON.stringify(value ?? {});
}

export async function recordAudit(env, user, action, details, ip) {
  await run(
    env,
    `INSERT INTO audit_logs(user_id, user_email, action, details, ip_address)
     VALUES (?, ?, ?, ?, ?)`,
    user?.id ?? null,
    user?.email ?? null,
    action,
    json(details),
    ip ?? null,
  );
}

export async function recordActivity(env, placeId, eventType, details = {}) {
  await run(
    env,
    `INSERT INTO lead_activities(place_id, event_type, details)
     VALUES (?, ?, ?)`,
    placeId,
    eventType,
    json(details),
  );
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(value) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) {
    throw new Error("Stored password hash is invalid.");
  }
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

async function passwordHash(password, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: PASSWORD_ITERATIONS },
      material,
      256,
    ),
  );
}

export async function authenticateUser(env, email, password) {
  const user = await first(
    env,
    "SELECT id, email, role, password_hash, salt FROM users WHERE lower(email) = ?",
    email.trim().toLowerCase(),
  );
  if (!user) return null;

  const actual = await passwordHash(password, user.salt);
  const expected = fromHex(user.password_hash);
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    mismatch |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  if (mismatch !== 0) return null;
  return { id: user.id, email: user.email, role: user.role };
}

export async function createSession(env, userId) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...tokenBytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  await run(env, "INSERT INTO sessions(token, user_id) VALUES (?, ?)", token, userId);
  return token;
}

export async function getSessionUser(env, request) {
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const cookieToken = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("session_token="))
    ?.slice("session_token=".length);
  const token = bearer || cookieToken || request.headers.get("X-Session-Token");
  if (!token) return null;
  return first(
    env,
    `SELECT u.id, u.email, u.role, u.created_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = ?`,
    token,
  );
}

export function tokenFromRequest(request) {
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const cookieToken = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("session_token="))
    ?.slice("session_token=".length);
  return bearer || cookieToken || request.headers.get("X-Session-Token");
}
