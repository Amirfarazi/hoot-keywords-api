import re
import time
from typing import Dict, List, Optional

import requests
from bs4 import BeautifulSoup
from duckduckgo_search import DDGS


DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}


ALLOWED_SCHEMES = ("http://", "https://")


def _is_direct_file_url(url: str, preferred_extensions: List[str]) -> bool:
    if not url or not url.startswith(ALLOWED_SCHEMES):
        return False
    # Quick extension check
    lowered = url.split("?")[0].lower()
    for ext in preferred_extensions:
        if lowered.endswith("." + ext.strip(".")):
            return True
    return False


def _head_content_type(url: str, timeout: int = 10) -> Optional[str]:
    try:
        response = requests.head(url, allow_redirects=True, timeout=timeout, headers=DEFAULT_HEADERS)
        ctype = response.headers.get("Content-Type")
        if ctype:
            return ctype.split(";")[0].strip().lower()
    except Exception:
        return None
    return None


def _extract_links_from_page(url: str) -> List[str]:
    try:
        response = requests.get(url, timeout=15, headers=DEFAULT_HEADERS)
        if not response.ok:
            return []
        soup = BeautifulSoup(response.text, "html.parser")
        anchors = soup.find_all("a", href=True)
        links = [a["href"] for a in anchors]
        # Normalize relative links if any
        absolute_links = []
        for href in links:
            if href.startswith("http://") or href.startswith("https://"):
                absolute_links.append(href)
            elif href.startswith("//"):
                absolute_links.append("https:" + href)
            elif href.startswith("/"):
                # Build absolute from base URL
                try:
                    from urllib.parse import urljoin
                    absolute_links.append(urljoin(url, href))
                except Exception:
                    pass
        return absolute_links
    except Exception:
        return []


def _search_web(query: str, max_results: int = 10) -> List[Dict]:
    results: List[Dict] = []
    with DDGS() as ddgs:
        for result in ddgs.text(query, max_results=max_results, safesearch="moderate"):  # type: ignore
            # result keys: title, href, body
            results.append({
                "title": result.get("title", ""),
                "href": result.get("href", ""),
                "snippet": result.get("body", ""),
            })
    return results


def perform_search_and_extract(
    query: str,
    extra_terms: Optional[List[str]] = None,
    preferred_extensions: Optional[List[str]] = None,
    max_results: int = 10,
) -> List[Dict]:
    if preferred_extensions is None:
        preferred_extensions = [
            "pdf", "zip", "mp3", "mp4", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "epub", "txt"
        ]
    if extra_terms is None:
        extra_terms = []

    enriched_query = query
    if extra_terms:
        enriched_query = f"{query} " + " ".join(extra_terms)

    # First: raw search
    raw_results = _search_web(enriched_query, max_results=max_results)

    # Collect candidate direct links
    candidates: List[Dict] = []

    # 1) Direct links from search results
    for r in raw_results:
        href = r.get("href", "")
        if _is_direct_file_url(href, preferred_extensions):
            candidates.append({
                "title": r.get("title", ""),
                "source_page": href,
                "direct_url": href,
                "reason": "Matched by extension",
                "content_type": _head_content_type(href) or "",
            })

    # 2) Extract from result pages
    for r in raw_results:
        page_url = r.get("href", "")
        if not page_url or not page_url.startswith(ALLOWED_SCHEMES):
            continue
        try:
            page_links = _extract_links_from_page(page_url)
        except Exception:
            page_links = []
        for link in page_links:
            if _is_direct_file_url(link, preferred_extensions):
                candidates.append({
                    "title": r.get("title", ""),
                    "source_page": page_url,
                    "direct_url": link,
                    "reason": "Found on page",
                    "content_type": _head_content_type(link) or "",
                })

    # Deduplicate by direct_url
    seen = set()
    unique_candidates: List[Dict] = []
    for c in candidates:
        url = c.get("direct_url")
        if not url or url in seen:
            continue
        seen.add(url)
        unique_candidates.append(c)

    return unique_candidates

