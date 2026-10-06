CREATE TABLE IF NOT EXISTS leads (
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
    status TEXT NOT NULL DEFAULT 'new',
    site_slug TEXT,
    site_storage TEXT,
    pitch TEXT,
    raw TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_site_slug
    ON leads(site_slug) WHERE site_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_generation_jobs (
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (place_id) REFERENCES leads(place_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_jobs_one_active_per_lead
    ON site_generation_jobs(place_id)
    WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_site_jobs_place_status
    ON site_generation_jobs(place_id, status);

CREATE TABLE IF NOT EXISTS site_generation_claims (
    job_id TEXT PRIMARY KEY,
    lease_until TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES site_generation_jobs(job_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lead_activities (
    activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (place_id) REFERENCES leads(place_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_place_time
    ON lead_activities(place_id, created_at, activity_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    user_email TEXT,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
