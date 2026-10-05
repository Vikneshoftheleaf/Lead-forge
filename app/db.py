import json
import uuid
import hashlib
import secrets

from . import d1
from .phones import indian_mobile_digits

STATUSES = ["new", "site_built", "pitched", "replied", "won", "lost"]

# ---------------------------------------------------------------------------
# Schema initialisation
# ---------------------------------------------------------------------------

def init():
    """Create all tables in D1 (idempotent – safe to call on every startup)."""
    stmts = [
        # ── leads ─────────────────────────────────────────────────────────
        {
            "sql": """CREATE TABLE IF NOT EXISTS leads(
                place_id TEXT PRIMARY KEY,
                name TEXT,
                phone TEXT,
                email TEXT,
                address TEXT,
                category TEXT,
                rating REAL,
                reviews INTEGER,
                website TEXT,
                lat REAL,
                lng REAL,
                status TEXT DEFAULT 'new',
                site_slug TEXT,
                site_storage TEXT,
                pitch TEXT,
                raw TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )""",
            "params": [],
        },
        # ── site_generation_jobs ──────────────────────────────────────────
        {
            "sql": """CREATE TABLE IF NOT EXISTS site_generation_jobs(
                job_id TEXT PRIMARY KEY,
                place_id TEXT NOT NULL,
                slug TEXT NOT NULL,
                previous_slug TEXT,
                previous_storage TEXT,
                status TEXT NOT NULL,
                stage TEXT NOT NULL DEFAULT 'queued',
                progress INTEGER NOT NULL DEFAULT 0,
                lead_data TEXT,
                error TEXT,
                site_url TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY(place_id) REFERENCES leads(place_id) ON DELETE CASCADE
            )""",
            "params": [],
        },
        {
            "sql": """CREATE INDEX IF NOT EXISTS idx_site_jobs_place_status
                ON site_generation_jobs(place_id, status)""",
            "params": [],
        },
        # ── lead_activities ───────────────────────────────────────────────
        {
            "sql": """CREATE TABLE IF NOT EXISTS lead_activities(
                activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
                place_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                details TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY(place_id) REFERENCES leads(place_id) ON DELETE CASCADE
            )""",
            "params": [],
        },
        {
            "sql": """CREATE INDEX IF NOT EXISTS idx_lead_activities_place_time
                ON lead_activities(place_id, created_at, activity_id)""",
            "params": [],
        },
        # ── users ─────────────────────────────────────────────────────────
        {
            "sql": """CREATE TABLE IF NOT EXISTS users(
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'editor',
                created_at TEXT DEFAULT (datetime('now'))
            )""",
            "params": [],
        },
        # ── sessions ──────────────────────────────────────────────────────
        {
            "sql": """CREATE TABLE IF NOT EXISTS sessions(
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )""",
            "params": [],
        },
        # ── audit_logs ────────────────────────────────────────────────────
        {
            "sql": """CREATE TABLE IF NOT EXISTS audit_logs(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                user_email TEXT,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )""",
            "params": [],
        },
    ]
    d1.batch(stmts)

    # ── Ensure root user exists ───────────────────────────────────────────
    root_email = "root@finsanta.com"
    row = d1.fetchone(
        "SELECT id FROM users WHERE lower(email)=?", [root_email]
    )
    if not row:
        root_id = str(uuid.uuid4())
        pwd_hash, salt = _hash_password("Letmein2026!")
        d1.execute(
            "INSERT INTO users(id, email, password_hash, salt, role) VALUES(?, ?, ?, ?, 'root')",
            [root_id, root_email, pwd_hash, salt],
        )
    else:
        d1.execute(
            "UPDATE users SET role='root' WHERE lower(email)=?", [root_email]
        )

    # Delete all non-root users (matches original behaviour)
    root_id_row = d1.fetchone(
        "SELECT id FROM users WHERE lower(email)=?", [root_email]
    )
    if root_id_row:
        d1.execute(
            "DELETE FROM users WHERE lower(email)!=?", [root_email]
        )
        d1.execute(
            "DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)"
        )


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def _hash_password(password: str, salt: str = None):
    if not salt:
        salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000
    )
    return key.hex(), salt


def verify_password(password: str, stored_hash: str, salt: str) -> bool:
    key_hex, _ = _hash_password(password, salt)
    return secrets.compare_digest(key_hex, stored_hash)


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

def create_user(email: str, password: str, role: str = "editor"):
    email = email.strip().lower()
    existing = d1.fetchone("SELECT id FROM users WHERE lower(email)=?", [email])
    if existing:
        raise ValueError("Email already registered")
    user_id = str(uuid.uuid4())
    pwd_hash, salt = _hash_password(password)
    d1.execute(
        "INSERT INTO users(id, email, password_hash, salt, role) VALUES(?, ?, ?, ?, ?)",
        [user_id, email, pwd_hash, salt, role],
    )
    return {"id": user_id, "email": email, "role": role}


def authenticate_user(email: str, password: str):
    email = email.strip().lower()
    row = d1.fetchone("SELECT * FROM users WHERE lower(email)=?", [email])
    if not row:
        return None
    if verify_password(password, row["password_hash"], row["salt"]):
        return {"id": row["id"], "email": row["email"], "role": row["role"]}
    return None


def create_session(user_id: str):
    token = secrets.token_urlsafe(32)
    d1.execute(
        "INSERT INTO sessions(token, user_id) VALUES(?, ?)", [token, user_id]
    )
    return token


def get_session_user(token: str):
    if not token:
        return None
    row = d1.fetchone(
        """SELECT u.id, u.email, u.role, u.created_at
           FROM sessions s
           JOIN users u ON s.user_id = u.id
           WHERE s.token=?""",
        [token],
    )
    return dict(row) if row else None


def delete_session(token: str):
    d1.execute("DELETE FROM sessions WHERE token=?", [token])


def get_user_by_id(user_id: str):
    row = d1.fetchone(
        "SELECT id, email, role, created_at FROM users WHERE id=?", [user_id]
    )
    return dict(row) if row else None


def list_users():
    rows = d1.query(
        "SELECT id, email, role, created_at FROM users ORDER BY created_at DESC"
    )
    return [dict(r) for r in rows]


def update_user_role(user_id: str, new_role: str):
    if new_role not in ("admin", "editor", "developer"):
        raise ValueError("Invalid role")
    affected = d1.changes(
        "UPDATE users SET role=? WHERE id=?", [new_role, user_id]
    )
    return affected > 0


def update_user_details(user_id: str, email: str = None, password: str = None):
    if email:
        email = email.strip().lower()
        existing = d1.fetchone(
            "SELECT id FROM users WHERE lower(email)=? AND id!=?",
            [email, user_id],
        )
        if existing:
            raise ValueError("Email already in use")
        d1.execute("UPDATE users SET email=? WHERE id=?", [email, user_id])
    if password:
        pwd_hash, salt = _hash_password(password)
        d1.execute(
            "UPDATE users SET password_hash=?, salt=? WHERE id=?",
            [pwd_hash, salt, user_id],
        )
    row = d1.fetchone("SELECT id FROM users WHERE id=?", [user_id])
    return row is not None


def delete_user(user_id: str):
    affected = d1.changes("DELETE FROM users WHERE id=?", [user_id])
    return affected > 0


# ---------------------------------------------------------------------------
# Audit logs
# ---------------------------------------------------------------------------

def record_audit_log(
    user_id,
    user_email,
    action: str,
    details: dict = None,
    ip_address: str = None,
):
    d1.execute(
        """INSERT INTO audit_logs(user_id, user_email, action, details, ip_address)
           VALUES(?, ?, ?, ?, ?)""",
        [
            user_id,
            user_email,
            action,
            json.dumps(details or {}, ensure_ascii=False),
            ip_address,
        ],
    )


def list_audit_logs(limit: int = 200):
    rows = d1.query(
        """SELECT id, user_id, user_email, action, details, ip_address, created_at
           FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?""",
        [max(1, min(limit, 500))],
    )
    result = []
    for r in rows:
        item = dict(r)
        try:
            item["details"] = json.loads(item["details"] or "{}")
        except Exception:
            item["details"] = {}
        result.append(item)
    return result


# ---------------------------------------------------------------------------
# Leads
# ---------------------------------------------------------------------------

def upsert_leads(leads):
    added = 0
    for l in leads:
        phone = (l.get("phone") or "").strip()
        if (l.get("website") or "").strip() or not (
            phone or (l.get("email") or "").strip()
        ) or (phone and not indian_mobile_digits(phone)):
            continue
        meta = d1.execute(
            """INSERT OR IGNORE INTO leads(
                   place_id, name, phone, email, address, category,
                   rating, reviews, website, lat, lng, raw
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                l["place_id"],
                l["name"],
                phone or None,
                l.get("email"),
                l["address"],
                l["category"],
                l["rating"],
                l["reviews"],
                l["website"],
                l["lat"],
                l["lng"],
                json.dumps(l["raw"]),
            ],
        )
        if meta.get("changes", 0):
            added += 1
            _record_activity(l["place_id"], "lead_created", {"source": "business_search"})
    return added


def list_leads(status=None, min_reviews=0, query=None):
    sql = "SELECT * FROM leads WHERE COALESCE(reviews,0)>=?"
    args = [min_reviews or 0]
    if status:
        sql += " AND status=?"
        args.append(status)
    if query:
        sql += " AND (name LIKE ? OR category LIKE ?)"
        args += [f"%{query}%", f"%{query}%"]
    sql += " ORDER BY created_at DESC"
    return d1.query(sql, args)


def get_lead(pid):
    return d1.fetchone("SELECT * FROM leads WHERE place_id=?", [pid])


def get_site_slug_owner(slug):
    row = d1.fetchone(
        "SELECT place_id FROM leads WHERE site_slug=? LIMIT 1", [slug]
    )
    return row["place_id"] if row else None


def claim_site_slug(pid, slug):
    affected = d1.changes(
        """UPDATE leads
           SET site_slug=?
           WHERE place_id=?
             AND NOT EXISTS (
                 SELECT 1 FROM leads AS other
                 WHERE other.site_slug=? AND other.place_id!=?
             )""",
        [slug, pid, slug, pid],
    )
    return affected == 1


def restore_site_slug(pid, current_slug, previous_slug, previous_storage):
    affected = d1.changes(
        """UPDATE leads
           SET site_slug=?, site_storage=?
           WHERE place_id=? AND site_slug=?""",
        [previous_slug, previous_storage, pid, current_slug],
    )
    return affected == 1


def update_lead(pid, **fields):
    if not fields:
        return
    allowed = {
        "name", "phone", "email", "address", "category",
        "rating", "reviews", "website", "status", "site_slug", "site_storage",
    }
    if not fields.keys() <= allowed:
        raise ValueError("unsupported lead field")

    old = get_lead(pid)
    if not old:
        return

    cols = ", ".join(f"{k}=?" for k in fields)
    d1.execute(
        f"UPDATE leads SET {cols} WHERE place_id=?",
        [*fields.values(), pid],
    )

    changed = {
        key: {"from": old[key], "to": value}
        for key, value in fields.items()
        if old.get(key) != value and key not in {"site_slug", "site_storage"}
    }
    if changed:
        if "status" in changed:
            _record_activity(
                pid, "status_changed", {"changes": {"status": changed["status"]}}
            )
        other_changes = {k: v for k, v in changed.items() if k != "status"}
        if other_changes:
            _record_activity(pid, "lead_updated", {"changes": other_changes})


def delete_lead(pid):
    affected = d1.changes("DELETE FROM leads WHERE place_id=?", [pid])
    return affected > 0


# ---------------------------------------------------------------------------
# Site generation jobs
# ---------------------------------------------------------------------------

def create_site_job(pid, slug, previous_slug, previous_storage, lead_data):
    job_id = uuid.uuid4().hex

    # Check for active jobs
    active = d1.fetchone(
        """SELECT job_id FROM site_generation_jobs
           WHERE place_id=? AND status IN ('queued', 'running') LIMIT 1""",
        [pid],
    )
    if active:
        return None

    # Claim the slug
    claimed = d1.changes(
        """UPDATE leads
           SET site_slug=?
           WHERE place_id=?
             AND NOT EXISTS (
                 SELECT 1 FROM leads AS other
                 WHERE other.site_slug=? AND other.place_id!=?
             )""",
        [slug, pid, slug, pid],
    )
    if claimed != 1:
        return None

    d1.execute(
        """INSERT INTO site_generation_jobs(
               job_id, place_id, slug, previous_slug, previous_storage,
               status, stage, progress, lead_data
           ) VALUES(?, ?, ?, ?, ?, 'queued', 'queued', 0, ?)""",
        [job_id, pid, slug, previous_slug, previous_storage, json.dumps(lead_data)],
    )
    _record_activity(pid, "site_generation_queued", {"job_id": job_id, "slug": slug})
    return job_id


def claim_site_job(job_id):
    affected = d1.changes(
        """UPDATE site_generation_jobs
           SET status='running', stage='starting', progress=2,
               error=NULL, updated_at=datetime('now')
           WHERE job_id=? AND status='queued'""",
        [job_id],
    )
    if affected:
        row = d1.fetchone(
            "SELECT place_id FROM site_generation_jobs WHERE job_id=?", [job_id]
        )
        if row:
            _record_activity(row["place_id"], "site_generation_started", {})
    return affected == 1


def update_site_job(job_id, status, error=None, site_url=None, stage=None, progress=None):
    assignments = ["status=?", "error=?", "site_url=?", "updated_at=datetime('now')"]
    args = [status, error, site_url]
    if stage is not None:
        assignments.append("stage=?")
        args.append(stage)
    if progress is not None:
        assignments.append("progress=?")
        args.append(max(0, min(100, int(progress))))
    args.append(job_id)
    d1.execute(
        f"UPDATE site_generation_jobs SET {', '.join(assignments)} WHERE job_id=?",
        args,
    )


def update_site_job_progress(job_id, stage, progress):
    d1.execute(
        """UPDATE site_generation_jobs
           SET stage=?, progress=?, updated_at=datetime('now')
           WHERE job_id=? AND status='running'""",
        [stage, max(0, min(99, int(progress))), job_id],
    )


def complete_site_generation(job_id, pid, slug, site_url):
    row = d1.fetchone("SELECT status FROM leads WHERE place_id=?", [pid])
    if not row:
        raise ValueError("The lead was removed before site generation completed.")

    d1.execute(
        """UPDATE leads
           SET site_slug=?, site_storage='r2',
               status=CASE WHEN status='new' THEN 'site_built' ELSE status END
           WHERE place_id=?""",
        [slug, pid],
    )
    d1.execute(
        """UPDATE site_generation_jobs
           SET status='completed', stage='Published', progress=100,
               site_url=?, error=NULL, updated_at=datetime('now')
           WHERE job_id=? AND status='running'""",
        [site_url, job_id],
    )
    if row["status"] == "new":
        _record_activity(
            pid,
            "status_changed",
            {"changes": {"status": {"from": "new", "to": "site_built"}}},
        )
    _record_activity(pid, "site_generation_completed", {"slug": slug})


def get_site_job(job_id):
    return d1.fetchone(
        "SELECT * FROM site_generation_jobs WHERE job_id=?", [job_id]
    )


def get_site_job_input(job_id):
    row = d1.fetchone(
        """SELECT place_id, slug, previous_slug, previous_storage, lead_data
           FROM site_generation_jobs WHERE job_id=?""",
        [job_id],
    )
    if not row:
        return None
    result = dict(row)
    result["lead_data"] = (
        json.loads(result["lead_data"]) if result["lead_data"] else None
    )
    return result


def recover_site_jobs():
    jobs = d1.query(
        """SELECT job_id, place_id, slug, previous_slug, previous_storage, lead_data
           FROM site_generation_jobs
           WHERE status IN ('queued', 'running')"""
    )
    for job in jobs:
        if job.get("lead_data"):
            continue
        # Restore the slug if no snapshot
        d1.execute(
            """UPDATE leads SET site_slug=?, site_storage=?
               WHERE place_id=? AND site_slug=?""",
            [job["previous_slug"], job["previous_storage"], job["place_id"], job["slug"]],
        )
        d1.execute(
            """UPDATE site_generation_jobs
               SET status='failed', stage='Failed', progress=0,
                   error='Cannot resume: saved lead snapshot is missing.',
                   updated_at=datetime('now')
               WHERE job_id=?""",
            [job["job_id"]],
        )
        lead_exists = d1.fetchone(
            "SELECT 1 FROM leads WHERE place_id=?", [job["place_id"]]
        )
        if lead_exists:
            _record_activity(
                job["place_id"],
                "site_generation_failed",
                {
                    "job_id": job["job_id"],
                    "error": "Cannot resume: saved lead snapshot is missing.",
                },
            )

    # Re-queue jobs that have snapshots
    d1.execute(
        """UPDATE site_generation_jobs
           SET status='queued', stage='queued', progress=0,
               updated_at=datetime('now')
           WHERE status IN ('queued', 'running') AND lead_data IS NOT NULL"""
    )
    return d1.query(
        "SELECT job_id FROM site_generation_jobs WHERE status='queued' ORDER BY created_at, job_id"
    )


def list_active_site_jobs():
    return d1.query(
        """SELECT job_id, place_id, status, stage, progress,
                  previous_slug, previous_storage, created_at
           FROM site_generation_jobs
           WHERE status IN ('queued', 'running')"""
    )


# ---------------------------------------------------------------------------
# Lead activities
# ---------------------------------------------------------------------------

def _record_activity(pid, event_type, details):
    d1.execute(
        """INSERT INTO lead_activities(place_id, event_type, details)
           VALUES(?, ?, ?)""",
        [pid, event_type, json.dumps(details, ensure_ascii=False)],
    )


def record_activity(pid, event_type, details=None):
    _record_activity(pid, event_type, details or {})


def list_lead_activity(pid, limit=100):
    rows = d1.query(
        """SELECT activity_id, event_type, details, created_at
           FROM lead_activities WHERE place_id=?
           ORDER BY created_at DESC, activity_id DESC LIMIT ?""",
        [pid, max(1, min(int(limit), 250))],
    )
    result = []
    for row in rows:
        item = dict(row)
        try:
            item["details"] = json.loads(item["details"] or "{}")
        except Exception:
            item["details"] = {}
        result.append(item)
    return result
