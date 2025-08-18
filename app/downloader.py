from typing import AsyncIterator
import aiohttp
from fastapi.responses import StreamingResponse
from fastapi import HTTPException


SAFE_CONTENT_TYPES = {
    "application/pdf",
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
    "audio/mpeg",
    "audio/mp3",
    "video/mp4",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/png",
    "image/jpeg",
    "text/plain",
    "application/epub+zip",
}


async def _stream_content(session: aiohttp.ClientSession, url: str) -> AsyncIterator[bytes]:
    async with session.get(url, allow_redirects=True, timeout=aiohttp.ClientTimeout(total=300)) as resp:
        if resp.status >= 400:
            raise HTTPException(status_code=resp.status, detail=f"Upstream status {resp.status}")
        while True:
            chunk = await resp.content.read(1024 * 64)
            if not chunk:
                break
            yield chunk


async def stream_file_download(url: str) -> StreamingResponse:
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="Invalid URL scheme")

    session = aiohttp.ClientSession()
    try:
        async with session.head(url, allow_redirects=True, timeout=aiohttp.ClientTimeout(total=30)) as head_resp:
            if head_resp.status >= 400:
                raise HTTPException(status_code=head_resp.status, detail=f"Upstream status {head_resp.status}")
            content_type = head_resp.headers.get("Content-Type", "application/octet-stream").split(";")[0].strip().lower()
            disposition_name = url.split("/")[-1].split("?")[0] or "download"

        headers = {
            "Content-Disposition": f"attachment; filename=\"{disposition_name}\"",
        }

        async def iterator():
            try:
                async for chunk in _stream_content(session, url):
                    yield chunk
            finally:
                await session.close()

        return StreamingResponse(iterator(), media_type=content_type or "application/octet-stream", headers=headers)
    except Exception:
        await session.close()
        raise

