import asyncio
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from . import db, phones, r2_storage, serp, sitegen

ROOT = Path(__file__).resolve().parent.parent
logger = logging.getLogger(__name__)
db.init()
SITE_GENERATION_WORKERS = 3
site_generation_executor = ThreadPoolExecutor(
    max_workers=SITE_GENERATION_WORKERS,
    thread_name_prefix="site-generation",
)
site_jobs_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    for job in db.recover_site_jobs():
        try:
            _submit_site_job(job["job_id"])
        except RuntimeError:
            logger.error(
                "Site generation job %s remains queued for the next restart.",
                job["job_id"],
            )
    try:
        yield
    finally:
        await asyncio.to_thread(site_generation_executor.shutdown, wait=True)


app = FastAPI(title="Lead Forge", lifespan=lifespan)


def _run_site_job(job_id):
    if not db.claim_site_job(job_id):
        return
    job = db.get_site_job(job_id)
    if not job:
        logger.error("Claimed site generation job %s is missing from the database.", job_id)
        return
    pid = job["place_id"]
    slug = job["slug"]
    previous_slug = job["previous_slug"]
    previous_storage = job["previous_storage"]

    def report_progress(stage, progress):
        db.update_site_job_progress(job_id, stage, progress)

    try:
        job_input = db.get_site_job_input(job_id)
        if not job_input or not job_input["lead_data"]:
            raise RuntimeError("Site generation job is missing its saved lead data.")
        lead = job_input["lead_data"]
        report_progress("Fetching business details and reviews", 8)
        context = serp.fetch_site_context(lead)
        built_slug = sitegen.build_site(
            lead, context, progress_callback=report_progress
        )
        if built_slug != slug:
            raise RuntimeError("Generated site URL did not match its reserved business slug.")
        site_url = sitegen.site_url(built_slug)
        db.complete_site_generation(job_id, pid, built_slug, site_url)
        if previous_slug and previous_slug != built_slug:
            try:
                sitegen.delete_site(previous_slug, previous_storage)
            except Exception:
                logger.exception(
                    "The new site was published, but the previous site %s could not be removed.",
                    previous_slug,
                )
    except Exception as error:
        logger.exception("Website generation failed for lead %s.", pid)
        try:
            if not db.restore_site_slug(pid, slug, previous_slug, previous_storage):
                logger.error("Could not release site slug reservation %s after build failure.", slug)
        except Exception:
            logger.exception("Could not restore the site slug after generation failed for lead %s.", pid)
        try:
            failure = str(error) or type(error).__name__
            db.record_activity(
                pid,
                "site_generation_failed",
                {"job_id": job_id, "error": failure},
            )
            db.update_site_job(
                job_id,
                "failed",
                error=failure,
                stage="Failed",
            )
        except Exception:
            logger.exception("Could not record failed website generation job %s.", job_id)


def _submit_site_job(job_id):
    try:
        site_generation_executor.submit(_run_site_job, job_id)
    except RuntimeError:
        logger.exception("Could not submit queued site generation job %s.", job_id)
        raise


from fastapi import Depends

class SearchReq(BaseModel):
    query: str
    ll: str | None = None
    pages: int = 1

class LeadUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=100)
    email: str | None = Field(default=None, max_length=320)
    address: str | None = Field(default=None, max_length=500)
    category: str | None = Field(default=None, max_length=200)
    rating: float | None = Field(default=None, ge=0, le=5)
    reviews: int | None = Field(default=None, ge=0)
    website: str | None = Field(default=None, max_length=2000)
    status: str | None = None

class AuthReq(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    password: str = Field(..., min_length=6)

class RoleUpdateReq(BaseModel):
    role: str = Field(..., pattern="^(admin|editor|developer)$")

class UserEditReq(BaseModel):
    email: str | None = Field(default=None, min_length=3, max_length=320)
    password: str | None = Field(default=None, min_length=6)

class SiteHtmlUpdate(BaseModel):
    html: str = Field(..., min_length=1, max_length=100_000)
    version: str = Field(..., pattern="^[a-f0-9]{64}$")


def get_current_user(request: Request):
    token = None
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    if not token:
        token = request.cookies.get("session_token")
    if not token:
        token = request.headers.get("X-Session-Token")
    user = db.get_session_user(token) if token else None
    if not user:
        raise HTTPException(401, "Not authenticated")
    return user

def require_roles(*allowed_roles: str):
    def role_checker(user = Depends(get_current_user)):
        if user["role"] == "root" or user["role"] == "admin" or user["role"] in allowed_roles:
            return user
        raise HTTPException(
            403,
            f"Access denied for role '{user['role']}'. Permission required: {', '.join(allowed_roles)}"
        )
    return role_checker


# Auth Endpoints
@app.post("/api/auth/signup")
def signup():
    raise HTTPException(403, "Public sign-up is disabled. Use one of the provisioned accounts.")

@app.post("/api/auth/login")
def login(req: AuthReq, request: Request):
    try:
        db.ensure_default_accounts()
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    user = db.authenticate_user(req.email, req.password)
    if not user:
        raise HTTPException(401, "Invalid email or password")
    token = db.create_session(user["id"])
    ip = request.client.host if request.client else None
    db.record_audit_log(user["id"], user["email"], "user_login", {}, ip)
    return {"token": token, "user": user}

@app.post("/api/auth/logout")
def logout(request: Request, user = Depends(get_current_user)):
    token = request.headers.get("Authorization", "").replace("Bearer ", "").strip() or request.cookies.get("session_token") or request.headers.get("X-Session-Token")
    if token:
        db.delete_session(token)
    ip = request.client.host if request.client else None
    db.record_audit_log(user["id"], user["email"], "user_logout", {}, ip)
    return {"ok": True}

@app.get("/api/auth/me")
def get_me(user = Depends(get_current_user)):
    return user


# Admin Endpoints (Root + Admin)
@app.get("/api/admin/users")
def get_users(current_user = Depends(get_current_user)):
    if current_user["role"] not in ("root", "admin"):
        raise HTTPException(403, "Access denied")
    return db.list_users()

@app.patch("/api/admin/users/{user_id}/role")
def update_role(user_id: str, req: RoleUpdateReq, request: Request, current_user = Depends(get_current_user)):
    if current_user["role"] not in ("root", "admin"):
        raise HTTPException(403, "Access denied")
    if user_id == current_user["id"]:
        raise HTTPException(400, "You cannot change your own role")
    target_user = db.get_user_by_id(user_id)
    if not target_user:
        raise HTTPException(404, "User not found")
    if target_user["role"] == "root":
        raise HTTPException(400, "Root user role cannot be changed")
    # Admin cannot assign admin role — only root can
    if req.role == "admin" and current_user["role"] != "root":
        raise HTTPException(403, "Only root can assign the admin role")
    try:
        updated = db.update_user_role(user_id, req.role)
        if not updated:
            raise HTTPException(404, "User not found")
        ip = request.client.host if request.client else None
        db.record_audit_log(
            current_user["id"],
            current_user["email"],
            "change_user_role",
            {"target_user_id": user_id, "new_role": req.role},
            ip
        )
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.patch("/api/admin/users/{user_id}")
def edit_user(user_id: str, req: UserEditReq, request: Request, current_user = Depends(get_current_user)):
    if current_user["role"] not in ("root", "admin"):
        raise HTTPException(403, "Access denied")
    target_user = db.get_user_by_id(user_id)
    if not target_user:
        raise HTTPException(404, "User not found")
    if target_user["role"] == "root" and current_user["role"] != "root":
        raise HTTPException(403, "Only root can edit the root user")
    if user_id == current_user["id"]:
        raise HTTPException(400, "Cannot edit your own account here")
    try:
        db.update_user_details(user_id, email=req.email, password=req.password)
        ip = request.client.host if request.client else None
        db.record_audit_log(current_user["id"], current_user["email"], "edit_user", {"target_user_id": user_id}, ip)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))

@app.delete("/api/admin/users/{user_id}")
def remove_user(user_id: str, request: Request, current_user = Depends(get_current_user)):
    if current_user["role"] not in ("root", "admin"):
        raise HTTPException(403, "Access denied")
    if user_id == current_user["id"]:
        raise HTTPException(400, "You cannot delete your own account")
    target_user = db.get_user_by_id(user_id)
    if not target_user:
        raise HTTPException(404, "User not found")
    if target_user["role"] == "root":
        raise HTTPException(403, "Root user cannot be deleted")
    if target_user["role"] == "admin" and current_user["role"] != "root":
        raise HTTPException(403, "Only root can delete admin users")
    deleted = db.delete_user(user_id)
    if not deleted:
        raise HTTPException(404, "User not found")
    ip = request.client.host if request.client else None
    db.record_audit_log(current_user["id"], current_user["email"], "delete_user", {"target_user_id": user_id, "email": target_user["email"]}, ip)
    return {"ok": True}

@app.get("/api/admin/activity-logs")
def get_activity_logs(current_user = Depends(get_current_user)):
    if current_user["role"] not in ("root", "admin"):
        raise HTTPException(403, "Access denied")
    return db.list_audit_logs()


# Application Endpoints with Role Guards
@app.post("/api/search")
def search(r: SearchReq, request: Request, user = Depends(require_roles("editor"))):
    try:
        res = serp.search_no_website(r.query, r.ll, r.pages)
    except Exception as e:
        raise HTTPException(400, str(e))
    added = db.upsert_leads(res["leads"])
    ip = request.client.host if request.client else None
    db.record_audit_log(user["id"], user["email"], "search_leads", {"query": r.query, "found": len(res["leads"]), "added": added}, ip)
    return {"scanned": res["scanned"], "found": len(res["leads"]), "added": added}

@app.get("/api/leads")
def leads(request: Request, status: str | None = None, min_reviews: int = 0, user = Depends(get_current_user)):
    base_url = os.getenv("BASE_URL", str(request.base_url)).rstrip("/")
    result = db.list_leads(status, min_reviews)
    active_jobs = {job["place_id"]: job for job in db.list_active_site_jobs()}
    for lead in result:
        job = active_jobs.get(lead["place_id"])
        lead["site_generation"] = (
            {
                "job_id": job["job_id"],
                "status": job["status"],
                "stage": job["stage"],
                "progress": job["progress"],
            }
            if job
            else None
        )
        published_slug = lead.get("site_slug")
        published_storage = lead.get("site_storage")
        if job and job.get("previous_storage") == "r2":
            published_slug = job.get("previous_slug")
            published_storage = job.get("previous_storage")
        lead["site_ready"] = bool(published_slug) and published_storage == "r2"
        mobile_digits = phones.indian_mobile_digits(lead.get("phone"))
        lead["whatsapp_phone"] = f"91{mobile_digits}" if mobile_digits else None
        lead["site_url"] = (
            sitegen.site_url(published_slug) if lead["site_ready"] else None
        )
        lead["site_public_url"] = (
            f"{base_url}{lead['site_url']}" if lead["site_ready"] else None
        )
    return result


@app.get("/api/sites")
def list_sites(request: Request, user = Depends(require_roles("developer"))):
    try:
        storage_sites = r2_storage.list_site_pages()
        lead_details = {
            lead["site_slug"]: lead for lead in db.list_published_site_leads()
        }
    except RuntimeError as error:
        raise HTTPException(502, str(error)) from error

    base_url = os.getenv("BASE_URL", str(request.base_url)).rstrip("/")
    return [
        {
            **site,
            "name": lead_details.get(site["slug"], {}).get("name") or site["slug"],
            "category": lead_details.get(site["slug"], {}).get("category"),
            "address": lead_details.get(site["slug"], {}).get("address"),
            "created_at": lead_details.get(site["slug"], {}).get("created_at"),
            "url": sitegen.site_url(site["slug"]),
            "public_url": f"{base_url}{sitegen.site_url(site['slug'])}",
        }
        for site in sorted(
            storage_sites,
            key=lambda item: (item.get("last_modified") or "", item["slug"]),
            reverse=True,
        )
    ]


@app.get("/api/sites/{slug}/html")
def get_site_html(slug: str, user = Depends(require_roles("developer"))):
    try:
        page, version = r2_storage.read_site_html(slug)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except r2_storage.R2ObjectNotFound as error:
        raise HTTPException(404, "site not found") from error
    except RuntimeError as error:
        raise HTTPException(502, str(error)) from error
    return {"slug": slug, "html": page, "version": version}


@app.put("/api/sites/{slug}/html")
def update_site_html(
    slug: str,
    update: SiteHtmlUpdate,
    request: Request,
    user = Depends(require_roles("developer")),
):
    try:
        version, size = r2_storage.save_site_html(
            slug, update.html, update.version
        )
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except r2_storage.R2ObjectNotFound as error:
        raise HTTPException(404, "site not found") from error
    except r2_storage.SiteVersionConflict as error:
        raise HTTPException(409, str(error)) from error
    except RuntimeError as error:
        raise HTTPException(502, str(error)) from error

    owner = db.get_site_slug_owner(slug)
    ip = request.client.host if request.client else None
    db.record_audit_log(
        user["id"],
        user["email"],
        "edit_site_html",
        {"slug": slug, "bytes": size, "version": version},
        ip,
    )
    if owner:
        db.record_activity(
            owner,
            "site_html_edited",
            {"slug": slug, "user_email": user["email"]},
        )
    return {"slug": slug, "version": version, "bytes": size}


@app.patch("/api/leads/{pid}")
def update_lead(pid: str, r: LeadUpdate, request: Request, user = Depends(require_roles("editor"))):
    if not db.get_lead(pid):
        raise HTTPException(404, "lead not found")
    fields = r.model_dump(exclude_unset=True)
    if "status" in fields and fields["status"] not in db.STATUSES:
        raise HTTPException(400, "bad status")
    if "name" in fields and fields["name"] is not None:
        fields["name"] = fields["name"].strip()
        if not fields["name"]:
            raise HTTPException(400, "name cannot be empty")
    db.update_lead(pid, **fields)
    ip = request.client.host if request.client else None
    db.record_audit_log(user["id"], user["email"], "update_lead", {"place_id": pid, "fields": fields}, ip)
    return {"ok": True}


@app.get("/api/leads/{pid}/activity")
def lead_activity(pid: str, user = Depends(get_current_user)):
    if not db.get_lead(pid):
        raise HTTPException(404, "lead not found")
    return db.list_lead_activity(pid)

@app.delete("/api/leads/{pid}")
def delete_lead(pid: str, request: Request, user = Depends(require_roles("editor"))):
    with site_jobs_lock:
        lead = db.get_lead(pid)
        if not lead:
            raise HTTPException(404, "lead not found")
        if any(job["place_id"] == pid for job in db.list_active_site_jobs()):
            raise HTTPException(409, "Wait for site generation to finish before deleting this lead.")
        try:
            sitegen.delete_site(lead.get("site_slug"), lead.get("site_storage"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        db.delete_lead(pid)
    ip = request.client.host if request.client else None
    db.record_audit_log(user["id"], user["email"], "delete_lead", {"place_id": pid, "name": lead.get("name")}, ip)
    return {"ok": True}

@app.post("/api/leads/{pid}/site", status_code=202)
def make_site(pid: str, request: Request, user = Depends(require_roles("developer"))):
    lead = db.get_lead(pid)
    if not lead:
        raise HTTPException(404, "lead not found")
    previous_slug = lead.get("site_slug")
    previous_storage = lead.get("site_storage")
    try:
        slug = sitegen.slugify(lead)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    with site_jobs_lock:
        if any(
            job["place_id"] == pid for job in db.list_active_site_jobs()
        ):
            raise HTTPException(409, "A site is already being generated for this lead.")
        owner = db.get_site_slug_owner(slug)
        if owner and owner != pid:
            raise HTTPException(
                409,
                f"A site for “{lead.get('name') or slug}” already exists. "
                "The business-name URL must be unique.",
            )
        current_site_owns_slug = (
            owner == pid
            and lead.get("site_slug") == slug
            and lead.get("site_storage") == "r2"
        )
    if not current_site_owns_slug:
        try:
            exists = r2_storage.site_exists(slug)
        except RuntimeError as error:
            raise HTTPException(502, str(error)) from error
        if exists:
            raise HTTPException(
                409,
                f"The URL /site/{slug} is already in use; refusing to overwrite it.",
            )
    with site_jobs_lock:
        if any(
            job["place_id"] == pid for job in db.list_active_site_jobs()
        ):
            raise HTTPException(409, "A site is already being generated for this lead.")
        owner = db.get_site_slug_owner(slug)
        if owner and owner != pid:
            raise HTTPException(
                409,
                f"A site for “{lead.get('name') or slug}” already exists. "
                "The business-name URL must be unique.",
            )
        job_id = db.create_site_job(
            pid,
            slug,
            previous_slug,
            previous_storage,
            dict(lead),
        )
        if not job_id:
            raise HTTPException(
                409,
                "A site generation is already active for this lead or its URL is in use.",
            )
        try:
            _submit_site_job(job_id)
        except RuntimeError as error:
            try:
                if not db.restore_site_slug(pid, slug, previous_slug, previous_storage):
                    logger.error("Could not release site slug reservation %s after worker submission failed.", slug)
                db.update_site_job(
                    job_id,
                    "failed",
                    error="Site generation worker is unavailable.",
                    stage="Failed",
                )
            except Exception:
                logger.exception("Could not clean up site job %s after worker submission failed.", job_id)
            raise HTTPException(503, "Site generation worker is unavailable.") from error
    ip = request.client.host if request.client else None
    db.record_audit_log(user["id"], user["email"], "generate_site", {"place_id": pid, "job_id": job_id, "slug": slug}, ip)
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/site-jobs/{job_id}")
def site_job(job_id: str, user = Depends(get_current_user)):
    job = db.get_site_job(job_id)
    if not job:
        raise HTTPException(404, "site generation job not found")
    return {
        "job_id": job["job_id"],
        "place_id": job["place_id"],
        "status": job["status"],
        "stage": job["stage"],
        "progress": job["progress"],
        "url": job["site_url"],
        "error": job["error"],
    }


@app.get("/site/{slug}", include_in_schema=False)
def serve_site(slug: str):
    try:
        page = sitegen.get_published_site(slug)
    except ValueError as error:
        raise HTTPException(404, "site not found") from error
    except r2_storage.R2ObjectNotFound as error:
        raise HTTPException(404, "site not found") from error
    return Response(
        content=page,
        media_type="text/html",
        headers={
            "Cache-Control": "no-cache, must-revalidate",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/site-assets/{slug}/{filename}", include_in_schema=False)
def serve_site_asset(slug: str, filename: str):
    try:
        body, content_type = sitegen.get_published_asset(slug, filename)
    except ValueError as error:
        raise HTTPException(404, "site asset not found") from error
    except r2_storage.R2ObjectNotFound as error:
        raise HTTPException(404, "site asset not found") from error
    return Response(
        content=body,
        media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )

@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")
