import os
from typing import List, Optional

from fastapi import FastAPI, Query, Request, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv

from .search import perform_search_and_extract
from .downloader import stream_file_download
from .llm import enrich_query_with_llm, score_candidates_with_llm


load_dotenv()

app = FastAPI(title="Direct File Search & Downloader")

static_dir = os.path.join(os.path.dirname(__file__), "static")
templates_dir = os.path.join(os.path.dirname(__file__), "templates")

app.mount("/static", StaticFiles(directory=static_dir), name="static")
templates = Jinja2Templates(directory=templates_dir)


def get_allowed_extensions() -> List[str]:
    env_value = os.getenv("ALLOWED_FILE_EXTENSIONS", "pdf,zip,mp3,mp4,docx,xlsx,pptx,png,jpg,jpeg,epub,txt")
    items = [x.strip().lower().lstrip(".") for x in env_value.split(",") if x.strip()]
    return [x for x in items if x]


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        "search.html",
        {
            "request": request,
            "query": "",
            "results": [],
            "message": None,
        },
    )


@app.get("/search", response_class=HTMLResponse)
async def search(request: Request, q: str = Query(default="", min_length=1)):
    query = q.strip()
    if not query:
        return RedirectResponse(url="/")

    allowed_extensions = get_allowed_extensions()

    # Step 1: LLM enrichment (optional; degrades gracefully if no key)
    enrichment = enrich_query_with_llm(query=query, allowed_extensions=allowed_extensions)

    # Step 2: Search + extract direct file links
    candidates = perform_search_and_extract(
        query=query,
        extra_terms=enrichment.get("keywords", []),
        preferred_extensions=enrichment.get("extensions", allowed_extensions),
        max_results=int(os.getenv("MAX_RESULTS", "10")),
    )

    if not candidates:
        return templates.TemplateResponse(
            "search.html",
            {
                "request": request,
                "query": query,
                "results": [],
                "message": "نتیجه‌ای برای دانلود مستقیم پیدا نشد. لطفاً عبارت دیگری امتحان کنید یا نوع فایل را مشخص‌تر کنید.",
            },
        )

    # Step 3: Rank with LLM (optional)
    ranked = score_candidates_with_llm(query=query, candidates=candidates)
    # Precompute encoded download urls for template
    from urllib.parse import quote
    for item in ranked:
        direct = item.get("direct_url", "")
        item["download_href"] = f"/download?url={quote(direct, safe='') }" if direct else "#"

    return templates.TemplateResponse(
        "search.html",
        {
            "request": request,
            "query": query,
            "results": ranked,
            "message": None,
        },
    )


@app.get("/download")
async def download(url: str = Query(..., description="Direct file URL")):
    try:
        return await stream_file_download(url)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Download failed: {exc}")

