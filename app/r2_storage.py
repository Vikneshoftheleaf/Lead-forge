from collections import OrderedDict
from functools import lru_cache
import mimetypes
import logging
import os
import threading
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

DEFAULT_BUCKET = "sites"
CACHE_TTL_SECONDS = 60
CACHE_MAX_ITEMS = 128
CACHE_MAX_BYTES = 16 * 1024 * 1024
MAX_OBJECT_BYTES = 2 * 1024 * 1024
logger = logging.getLogger(__name__)


class R2ObjectNotFound(FileNotFoundError):
    pass


_cache: OrderedDict[str, tuple[float, bytes, str]] = OrderedDict()
_cache_size = 0
_cache_lock = threading.Lock()


@lru_cache(maxsize=1)
def _client():
    account_id = os.getenv("R2_ACCOUNT_ID")
    endpoint = os.getenv("R2_ENDPOINT_URL") or (
        f"https://{account_id}.r2.cloudflarestorage.com" if account_id else None
    )
    access_key = os.getenv("R2_ACCESS_KEY_ID")
    secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
    if not endpoint or not access_key or not secret_key:
        raise RuntimeError(
            "Cloudflare R2 is not configured; set R2_ACCOUNT_ID (or "
            "R2_ENDPOINT_URL), R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY."
        )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="auto",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            connect_timeout=3,
            read_timeout=5,
            retries={"max_attempts": 2},
        ),
    )


def _bucket():
    return os.getenv("R2_BUCKET_NAME", DEFAULT_BUCKET)


def _cached_object(key):
    global _cache_size
    with _cache_lock:
        cached = _cache.get(key)
        if cached is None:
            return None
        expires_at, body, content_type = cached
        if expires_at <= time.monotonic():
            del _cache[key]
            _cache_size -= len(body)
            return None
        _cache.move_to_end(key)
        return body, content_type


def _cache_object(key, body, content_type):
    global _cache_size
    if len(body) > CACHE_MAX_BYTES:
        return
    with _cache_lock:
        previous = _cache.pop(key, None)
        if previous:
            _cache_size -= len(previous[1])
        _cache[key] = (time.monotonic() + CACHE_TTL_SECONDS, body, content_type)
        _cache_size += len(body)
        while len(_cache) > CACHE_MAX_ITEMS or _cache_size > CACHE_MAX_BYTES:
            _, (_, evicted_body, _) = _cache.popitem(last=False)
            _cache_size -= len(evicted_body)


def invalidate_site_cache(slug):
    global _cache_size
    prefixes = (f"{slug}.html", f"{slug}/")
    with _cache_lock:
        for key in list(_cache):
            if key == prefixes[0] or key.startswith(prefixes[1]):
                _, body, _ = _cache.pop(key)
                _cache_size -= len(body)


def get_object(key):
    cached = _cached_object(key)
    if cached:
        return cached

    try:
        result = _client().get_object(Bucket=_bucket(), Key=key)
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in {"NoSuchKey", "NoSuchObject", "NotFound", "404"}:
            raise R2ObjectNotFound(key) from error
        raise RuntimeError(f"Cloudflare R2 read failed ({code or 'unknown error'}).") from error

    body_stream = result["Body"]
    try:
        body = body_stream.read(MAX_OBJECT_BYTES + 1)
    finally:
        body_stream.close()
    if len(body) > MAX_OBJECT_BYTES:
        raise RuntimeError("Cloudflare R2 object exceeds the configured size limit.")
    content_type = result.get("ContentType") or mimetypes.guess_type(key)[0] or "application/octet-stream"
    _cache_object(key, body, content_type)
    return body, content_type


def site_exists(slug):
    try:
        _client().head_object(Bucket=_bucket(), Key=f"{slug}.html")
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code not in {"NoSuchKey", "NoSuchObject", "NotFound", "404"} and status != 404:
            raise RuntimeError(
                f"Cloudflare R2 lookup failed ({code or 'unknown error'})."
            ) from error
    else:
        return True

    try:
        page = _client().list_objects_v2(
            Bucket=_bucket(), Prefix=f"{slug}/", MaxKeys=1
        )
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        raise RuntimeError(
            f"Cloudflare R2 lookup failed ({code or 'unknown error'})."
        ) from error
    return bool(page.get("Contents"))


def put_object(key, body, content_type, cache_control):
    try:
        _client().put_object(
            Bucket=_bucket(),
            Key=key,
            Body=body,
            ContentType=content_type,
            CacheControl=cache_control,
        )
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        raise RuntimeError(f"Cloudflare R2 write failed ({code or 'unknown error'}).") from error
    invalidate_site_cache(key.removesuffix(".html").split("/", 1)[0])


def publish_site(slug, page, site_directory, images):
    uploaded_assets = []
    page_body = page.encode("utf-8")
    html_upload_attempted = False
    try:
        for image in images:
            relative_path = image["url"]
            object_key = f"{slug}/{relative_path.rsplit('/', 1)[-1]}"
            image_path = site_directory / relative_path
            content_type = (
                image.get("content_type")
                or mimetypes.guess_type(image_path.name)[0]
                or "application/octet-stream"
            )
            put_object(
                object_key,
                image_path.read_bytes(),
                content_type,
                "public, max-age=31536000, immutable",
            )
            uploaded_assets.append(object_key)

        html_upload_attempted = True
        put_object(
            f"{slug}.html",
            page_body,
            "text/html; charset=utf-8",
            "public, max-age=60, stale-while-revalidate=300",
        )
    except Exception:
        published = False
        safe_to_remove_assets = True
        if html_upload_attempted:
            invalidate_site_cache(slug)
            try:
                current_page, _ = get_object(f"{slug}.html")
                published = current_page == page_body
            except R2ObjectNotFound:
                pass
            except Exception:
                safe_to_remove_assets = False
                logger.exception(
                    "Could not confirm whether the HTML upload completed for site %s.",
                    slug,
                )
        if published:
            logger.warning(
                "The HTML upload for site %s reported an error, but the matching page "
                "is present in R2.",
                slug,
            )
        elif safe_to_remove_assets:
            _remove_uploaded_assets(slug, uploaded_assets)
        else:
            logger.error(
                "Keeping uploaded assets for site %s because the HTML publish outcome "
                "could not be confirmed.",
                slug,
            )
        if not published:
            raise

    _remove_stale_assets(slug, images)


def _remove_uploaded_assets(slug, uploaded_assets):
    if uploaded_assets:
        try:
            _client().delete_objects(
                Bucket=_bucket(),
                Delete={"Objects": [{"Key": key} for key in uploaded_assets], "Quiet": True},
            )
        except Exception:
            logger.exception("Could not remove incomplete R2 assets for site %s.", slug)


def _remove_stale_assets(slug, images):
    try:
        client = _client()
        paginator = client.get_paginator("list_objects_v2")
        current_assets = {f"{slug}/{image['url'].rsplit('/', 1)[-1]}" for image in images}
        stale_assets = [
            item["Key"]
            for page_result in paginator.paginate(Bucket=_bucket(), Prefix=f"{slug}/")
            for item in page_result.get("Contents", [])
            if item["Key"] not in current_assets
        ]
        for offset in range(0, len(stale_assets), 1000):
            client.delete_objects(
                Bucket=_bucket(),
                Delete={
                    "Objects": [{"Key": key} for key in stale_assets[offset:offset + 1000]],
                    "Quiet": True,
                },
            )
    except Exception:
        logger.exception("Could not remove outdated R2 assets for site %s.", slug)


def delete_site(slug):
    client = _client()
    bucket = _bucket()
    paginator = client.get_paginator("list_objects_v2")
    keys = [f"{slug}.html"]
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{slug}/"):
        keys.extend(item["Key"] for item in page.get("Contents", []))
    for offset in range(0, len(keys), 1000):
        chunk = keys[offset:offset + 1000]
        if chunk:
            client.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": key} for key in chunk], "Quiet": True},
            )
    invalidate_site_cache(slug)
