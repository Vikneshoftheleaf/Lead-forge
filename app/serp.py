import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import requests

from .phones import indian_mobile_digits

SERPAPI_URL = "https://serpapi.com/search.json"
logger = logging.getLogger(__name__)


def _api_search(params):
    response = requests.get(SERPAPI_URL, params=params, timeout=(5, 25))
    response.raise_for_status()
    data = response.json()
    if data.get("error"):
        raise RuntimeError(f"SerpAPI error: {data['error']}")
    return data


def _images(items):
    images = []
    for item in items or []:
        if isinstance(item, str):
            url, attribution = item, None
        elif isinstance(item, dict):
            url = item.get("thumbnail") or item.get("image") or item.get("original")
            user = item.get("user") or {}
            attribution = item.get("author") or user.get("name")
        else:
            continue
        if isinstance(url, str) and url.startswith("https://") and url not in {
            image["url"] for image in images
        }:
            images.append({"url": url, "attribution": attribution})
    return images


def fetch_site_context(lead):
    """Fetch a place's details, highly rated reviews, and Maps photos for site generation."""
    key = os.getenv("SERPAPI_KEY")
    if not key:
        raise RuntimeError("SERPAPI_KEY missing in .env")

    raw = lead.get("raw") or {}
    if isinstance(raw, str):
        raw = json.loads(raw)
    if not isinstance(raw, dict):
        raw = {}

    details_params = {
        "engine": "google_maps",
        "place_id": lead["place_id"],
        "api_key": key,
        "hl": "en",
    }
    reviews_params = {
        "engine": "google_maps_reviews",
        "place_id": lead["place_id"],
        "sort_by": "ratingHigh",
        "hl": "en",
        "api_key": key,
    }
    with ThreadPoolExecutor(max_workers=2) as executor:
        details_future = executor.submit(_api_search, details_params)
        reviews_future = executor.submit(_api_search, reviews_params)
        details_response = details_future.result()
        try:
            reviews_response = reviews_future.result()
        except (requests.RequestException, RuntimeError, ValueError) as error:
            logger.warning(
                "Google Maps reviews unavailable for place %s (%s).",
                lead["place_id"],
                type(error).__name__,
            )
            reviews_response = {}

    details = details_response.get("place_results") or {}
    if not details:
        raise RuntimeError("Google Maps did not return details for this business.")

    data_id = details.get("data_id") or raw.get("data_id")
    google_url = (
        "https://www.google.com/maps/search/?api=1"
        f"&query={requests.utils.quote(lead.get('name') or '')}"
        f"&query_place_id={requests.utils.quote(lead['place_id'])}"
    )
    reviews = []
    for review in reviews_response.get("reviews", []):
        rating = review.get("rating")
        text = review.get("snippet") or (review.get("extracted_snippet") or {}).get("original")
        try:
            rating = float(rating)
        except (TypeError, ValueError):
            continue
        if rating >= 4 and text:
            user = review.get("user") or {}
            reviews.append({
                "rating": rating,
                "text": text,
                "reviewer": user.get("name"),
                "date": review.get("iso_date") or review.get("date"),
                "url": review.get("link") or google_url,
            })

    photos = _images(details.get("images"))
    photos.extend(_images([raw.get("thumbnail")]))
    if data_id:
        try:
            photos_response = _api_search({
                "engine": "google_maps_photos",
                "data_id": data_id,
                "api_key": key,
                "hl": "en",
            })
            photo_results = photos_response.get("photos") or photos_response.get("photos_results") or []
            if isinstance(photo_results, dict):
                photo_results = [
                    image
                    for category in photo_results.values()
                    if isinstance(category, list)
                    for image in category
                ]
            photos.extend(_images(photo_results))
        except (requests.RequestException, RuntimeError, ValueError) as error:
            logger.warning(
                "Additional Google Maps photos unavailable for place %s (%s); "
                "using listing photos and optional Unsplash photos.",
                lead["place_id"],
                type(error).__name__,
            )
    photos = list({image["url"]: image for image in photos}.values())[:8]
    gps = details.get("gps_coordinates") or {}

    listing = {
        "name": details.get("title") or lead.get("name"),
        "category": details.get("type") or lead.get("category"),
        "address": details.get("address") or lead.get("address"),
        "phone": details.get("phone") or lead.get("phone"),
        "rating": details.get("rating") or lead.get("rating"),
        "review_count": details.get("reviews") or lead.get("reviews"),
        "description": details.get("description"),
        "hours": details.get("operating_hours") or details.get("hours"),
        "open_state": details.get("open_state"),
        "services": details.get("service_options"),
        "attributes": details.get("extensions"),
        "additional_listing_details": {
            field: details[field]
            for field in (
                "booking_link",
                "events",
                "check_in_time",
                "check_out_time",
                "links",
                "about",
                "accessibility",
                "amenities",
                "highlights",
                "popular_times",
                "located_in",
                "neighborhoods",
                "food_and_drink",
            )
            if details.get(field) is not None
        },
        "price": details.get("price"),
        "latitude": gps.get("latitude") or lead.get("lat"),
        "longitude": gps.get("longitude") or lead.get("lng"),
        "google_maps_url": google_url,
    }
    return {"listing": listing, "positive_reviews": reviews[:8], "google_photos": photos}

def search_no_website(query: str, ll: str | None = None, pages: int = 1):
    """Fetch SerpAPI listings with no website and at least one contact method.
    ll example: '@13.0827,80.2707,14z'. Each page = 1 SerpAPI credit (20 results)."""
    key = os.getenv("SERPAPI_KEY")
    if not key:
        raise RuntimeError("SERPAPI_KEY missing in .env")
    out, seen_total = [], 0
    for p in range(pages):
        params = {"engine": "google_maps", "type": "search", "q": query,
                  "start": p * 20, "api_key": key}
        if ll: params["ll"] = ll
        data = _api_search(params)
        results = data.get("local_results", [])
        if not results: break
        seen_total += len(results)
        for r in results:
            website = (r.get("website") or "").strip()
            phone = (r.get("phone") or "").strip()
            email = (r.get("email") or "").strip()
            if (
                website
                or not r.get("place_id")
                or (phone and not indian_mobile_digits(phone))
                or not (phone or email)
            ):
                continue
            gps = r.get("gps_coordinates", {})
            out.append({
                "place_id": r["place_id"], "name": r.get("title"), "phone": phone or None,
                "email": email or None,
                "address": r.get("address"), "category": r.get("type"),
                "rating": r.get("rating"), "reviews": r.get("reviews", 0),
                "website": None, "lat": gps.get("latitude"), "lng": gps.get("longitude"), "raw": r})
    return {"scanned": seen_total, "leads": out}
