#!/usr/bin/env python3
"""
migrate_to_d1.py
================
Reads every table from the local leads.db SQLite file and inserts
the rows into Cloudflare D1 via the REST API.

Usage:
    python -u migrate_to_d1.py

Prerequisites:
    pip install requests python-dotenv
    .env must contain CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID
"""

import sqlite3
import sys
import time
from pathlib import Path

# Force unbuffered stdout so we see progress in real time
sys.stdout.reconfigure(line_buffering=True)

from dotenv import load_dotenv
load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent))

import os
import requests

DB_PATH = Path(__file__).resolve().parent / "leads.db"

# Tables in dependency order (parents before children).
# Sessions skipped -- stale tokens, FK constraint would reject them anyway.
TABLES = [
    "leads",
    "users",
    "site_generation_jobs",
    "lead_activities",
    "audit_logs",
]

CF_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/"
    f"{os.environ['CF_ACCOUNT_ID']}/d1/database/"
    f"{os.environ['CF_D1_DATABASE_ID']}/query"
)
CF_HEADERS = {
    "Authorization": f"Bearer {os.environ['CF_API_TOKEN']}",
    "Content-Type": "application/json",
}


def d1_exec(sql: str, params: list = None, retries: int = 3) -> dict:
    """POST a single SQL statement to D1 with retry on timeout."""
    payload = {"sql": sql, "params": list(params or [])}
    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(CF_URL, headers=CF_HEADERS, json=payload, timeout=20)
            resp.raise_for_status()
            data = resp.json()
            if not data.get("success"):
                errors = data.get("errors") or data.get("messages") or []
                raise RuntimeError(f"D1 error: {errors}")
            results = data.get("result", [])
            return results[0].get("meta", {}) if results else {}
        except requests.exceptions.Timeout:
            if attempt == retries:
                raise
            print(f"    timeout, retrying ({attempt}/{retries})...", flush=True)
            time.sleep(2 * attempt)
        except requests.exceptions.HTTPError as e:
            # Print the actual D1 error body for debugging
            try:
                body = e.response.json()
            except Exception:
                body = e.response.text
            raise RuntimeError(f"HTTP {e.response.status_code}: {body}") from e


def create_schema():
    ddl = [
        """CREATE TABLE IF NOT EXISTS leads(
            place_id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT,
            address TEXT, category TEXT, rating REAL, reviews INTEGER,
            website TEXT, lat REAL, lng REAL, status TEXT DEFAULT 'new',
            site_slug TEXT, site_storage TEXT, pitch TEXT, raw TEXT,
            created_at TEXT DEFAULT (datetime('now')))""",

        """CREATE TABLE IF NOT EXISTS users(
            id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'editor',
            created_at TEXT DEFAULT (datetime('now')))""",

        """CREATE TABLE IF NOT EXISTS sessions(
            token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)""",

        """CREATE TABLE IF NOT EXISTS site_generation_jobs(
            job_id TEXT PRIMARY KEY, place_id TEXT NOT NULL, slug TEXT NOT NULL,
            previous_slug TEXT, previous_storage TEXT, status TEXT NOT NULL,
            stage TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0,
            lead_data TEXT, error TEXT, site_url TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(place_id) REFERENCES leads(place_id) ON DELETE CASCADE)""",

        """CREATE INDEX IF NOT EXISTS idx_site_jobs_place_status
            ON site_generation_jobs(place_id, status)""",

        """CREATE TABLE IF NOT EXISTS lead_activities(
            activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
            place_id TEXT NOT NULL, event_type TEXT NOT NULL, details TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(place_id) REFERENCES leads(place_id) ON DELETE CASCADE)""",

        """CREATE INDEX IF NOT EXISTS idx_lead_activities_place_time
            ON lead_activities(place_id, created_at, activity_id)""",

        """CREATE TABLE IF NOT EXISTS audit_logs(
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT,
            user_email TEXT, action TEXT NOT NULL, details TEXT,
            ip_address TEXT, created_at TEXT DEFAULT (datetime('now')))""",
    ]
    for i, sql in enumerate(ddl, 1):
        name = sql.strip().split()[2]  # TABLE/INDEX name
        print(f"  [{i}/{len(ddl)}] {name}...", flush=True)
        d1_exec(sql)
    print(f"  Schema done ({len(ddl)} statements).", flush=True)


def sqlite_rows(table: str) -> list[dict]:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute(f"SELECT * FROM {table}").fetchall()  # noqa: S608
    con.close()
    return [dict(r) for r in rows]


def insert_rows(table: str, rows: list[dict]):
    if not rows:
        print(f"  {table}: 0 rows, skipping.", flush=True)
        return
    cols = list(rows[0].keys())
    placeholders = ", ".join("?" * len(cols))
    sql = f"INSERT OR IGNORE INTO {table}({', '.join(cols)}) VALUES({placeholders})"  # noqa: S608
    ok = 0
    skipped = 0
    for i, row in enumerate(rows, 1):
        try:
            meta = d1_exec(sql, [row[c] for c in cols])
            if meta.get("changes", 0):
                ok += 1
            else:
                skipped += 1
        except Exception as exc:
            print(f"\n  WARNING [{table} row {i}]: {exc}", flush=True)
            skipped += 1
        print(f"  {table}: {i}/{len(rows)} (inserted={ok}, ignored={skipped})", end="\r", flush=True)
    print(f"  {table}: {len(rows)} rows processed -- inserted={ok}, ignored={skipped}    ", flush=True)


def ensure_root():
    root_email = "root@finsanta.com"
    row_list = []
    try:
        resp = requests.post(
            CF_URL, headers=CF_HEADERS,
            json={"sql": "SELECT role FROM users WHERE lower(email)=?", "params": [root_email]},
            timeout=20
        )
        data = resp.json()
        row_list = (data.get("result") or [{}])[0].get("results") or []
    except Exception:
        pass

    if row_list:
        d1_exec("UPDATE users SET role='root' WHERE lower(email)=?", [root_email])
        print(f"  Root user role confirmed.", flush=True)
    else:
        print(f"  WARNING: root@finsanta.com not found in D1 users. Run the app once to seed it.", flush=True)


def main():
    if not DB_PATH.exists():
        print(f"ERROR: {DB_PATH} not found.", file=sys.stderr, flush=True)
        sys.exit(1)

    print("=== Lead Forge -> Cloudflare D1 Migration ===", flush=True)
    print(f"Source: {DB_PATH}", flush=True)
    print(f"Target: {os.environ.get('CF_D1_DATABASE_ID', '?')}", flush=True)
    print("", flush=True)

    print("[1/3] Creating schema...", flush=True)
    create_schema()
    print("", flush=True)

    print("[2/3] Migrating table data...", flush=True)
    for table in TABLES:
        try:
            rows = sqlite_rows(table)
            insert_rows(table, rows)
        except Exception as exc:
            print(f"\n  ERROR on table '{table}': {exc}", file=sys.stderr, flush=True)
    print("", flush=True)

    print("[3/3] Verifying root user...", flush=True)
    ensure_root()
    print("", flush=True)

    print("Migration complete.", flush=True)
    print("NOTE: Sessions were not migrated -- users must log in again.", flush=True)


if __name__ == "__main__":
    main()
