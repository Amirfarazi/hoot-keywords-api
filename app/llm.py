import os
from typing import Dict, List

from openai import OpenAI


def _get_client() -> OpenAI | None:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None
    try:
        client = OpenAI(api_key=api_key)
        return client
    except Exception:
        return None


def enrich_query_with_llm(query: str, allowed_extensions: List[str]) -> Dict:
    client = _get_client()
    if client is None:
        return {"keywords": ["download", "direct link"], "extensions": allowed_extensions}

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    prompt = (
        "You are assisting a web file searcher. Given a user query, suggest up to 4 additional "
        "keywords that are likely to yield direct file downloads and return a small list of file "
        "extensions from the allowlist that best match the user's intent.\n\n"
        f"User query: {query}\n"
        f"Allowlist extensions: {', '.join(allowed_extensions)}\n"
        "Respond as JSON with keys 'keywords' (list[str]) and 'extensions' (list[str])."
    )

    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "Return only JSON."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
        )
        content = completion.choices[0].message.content or "{}"
        import json
        data = json.loads(content)
        keywords = [k for k in data.get("keywords", []) if isinstance(k, str)][:4]
        extensions = [e.strip('.').lower() for e in data.get("extensions", []) if isinstance(e, str)]
        extensions = [e for e in extensions if e in set(allowed_extensions)] or allowed_extensions
        if not keywords:
            keywords = ["download", "file", "direct link"]
        return {"keywords": keywords, "extensions": extensions}
    except Exception:
        return {"keywords": ["download", "direct link"], "extensions": allowed_extensions}


def score_candidates_with_llm(query: str, candidates: List[Dict]) -> List[Dict]:
    client = _get_client()
    if client is None:
        # Simple fallback: keep order
        return candidates[:20]

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    import json
    prompt = (
        "Rank downloadable file candidates for relevance to the user query. "
        "Return the same list sorted best-first. Keep original fields and do not add new ones.\n\n"
        f"User query: {query}\n"
        f"Candidates JSON: {json.dumps(candidates[:30])}\n"
        "Respond with JSON array only."
    )
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "Return only raw JSON array."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.0,
        )
        content = completion.choices[0].message.content or "[]"
        ranked = json.loads(content)
        if isinstance(ranked, list) and ranked:
            return ranked[:50]
    except Exception:
        pass
    return candidates[:20]

