"""
Cloudflare D1 REST API client.

Exposes a thin synchronous wrapper around the D1 HTTP API so that db.py
can call it exactly like sqlite3 -- returning list-of-dicts instead of Rows.

Environment variables required:
    CF_API_TOKEN      -- Cloudflare API token with D1:Edit permission
    CF_ACCOUNT_ID     -- Cloudflare account ID
    CF_D1_DATABASE_ID -- The D1 database UUID
"""

import os
import logging

import requests
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

_BASE = "https://api.cloudflare.com/client/v4"


def _cfg():
    token = os.environ["CF_API_TOKEN"]
    account = os.environ["CF_ACCOUNT_ID"]
    db_id = os.environ["CF_D1_DATABASE_ID"]
    return token, account, db_id


def _headers():
    token, _, _ = _cfg()
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _url():
    _, account, db_id = _cfg()
    return f"{_BASE}/accounts/{account}/d1/database/{db_id}/query"


# ---------------------------------------------------------------------------
# Core query helpers
# ---------------------------------------------------------------------------

def _unwrap(resp: requests.Response) -> list[dict]:
    """Parse the D1 REST response and return rows as list of dicts."""
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        errors = data.get("errors") or data.get("messages") or []
        raise RuntimeError(f"D1 query failed: {errors}")
    # result is always a list with one item per statement
    results = data.get("result", [])
    if not results:
        return []
    return results[0].get("results") or []


def query(sql: str, params: list = None) -> list[dict]:
    """Execute a single SQL statement; returns rows as list of dicts."""
    payload = {"sql": sql, "params": list(params) if params else []}
    resp = requests.post(_url(), headers=_headers(), json=payload, timeout=30)
    return _unwrap(resp)


def execute(sql: str, params: list = None) -> dict:
    """
    Execute a write statement (INSERT/UPDATE/DELETE).
    Returns meta dict with keys: last_row_id, changes, duration_ms.
    """
    payload = {"sql": sql, "params": list(params) if params else []}
    resp = requests.post(_url(), headers=_headers(), json=payload, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        errors = data.get("errors") or data.get("messages") or []
        raise RuntimeError(f"D1 execute failed: {errors}")
    results = data.get("result", [])
    meta = results[0].get("meta", {}) if results else {}
    return meta


def batch(statements: list[dict]) -> list[list[dict]]:
    """
    Execute multiple SQL statements sequentially (one HTTP POST each).

    D1's REST API does not support sending a JSON array for batching --
    each statement must be its own request. This function handles that
    transparently so callers can treat it as an atomic group.

    Each item in `statements` is {"sql": ..., "params": [...]}.
    Returns a list of row-lists, one per statement.
    """
    results = []
    for stmt in statements:
        payload = {
            "sql": stmt["sql"],
            "params": list(stmt.get("params") or []),
        }
        resp = requests.post(_url(), headers=_headers(), json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            errors = data.get("errors") or data.get("messages") or []
            raise RuntimeError(f"D1 batch statement failed: {errors}")
        inner = data.get("result", [])
        results.append(inner[0].get("results") or [] if inner else [])
    return results


def fetchone(sql: str, params: list = None) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def changes(sql: str, params: list = None) -> int:
    """Run a write statement and return the number of affected rows."""
    meta = execute(sql, params)
    return int(meta.get("changes", 0))
