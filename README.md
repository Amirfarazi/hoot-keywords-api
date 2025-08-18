## File Search & Direct Download Web App (FastAPI)

This app provides a simple search interface powered by DuckDuckGo search and your ChatGPT (OpenAI) API key to refine results and surface direct downloadable files (e.g., PDF, ZIP, MP3) instead of just listing pages. Downloads are proxied via the backend for convenience.

### Features
- Search the web and extract direct file links from results pages
- Optional LLM-assisted ranking and query enrichment (requires `OPENAI_API_KEY`)
- Safe defaults: file-extension allowlist and content-type checks
- Simple UI using Jinja2 templates

### Important Notes
- Only download content that you have the legal right to download.
- The app attempts to identify direct file links heuristically; results may vary by site.
- LLM features gracefully degrade if `OPENAI_API_KEY` is not set.

### Setup
```bash
cd /workspace
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # then edit .env
```

Edit `.env` to set your OpenAI API key and optional settings.

### Run
```bash
source .venv/bin/activate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open `http://localhost:8000` in your browser.

### Environment Variables
- `OPENAI_API_KEY`: Your OpenAI API key (optional but recommended)
- `OPENAI_MODEL`: Model name (default: `gpt-4o-mini`)
- `ALLOWED_FILE_EXTENSIONS`: Comma-separated list of file extensions to allow (e.g., `pdf,zip,mp3,mp4,docx,xlsx,pptx,png,jpg,jpeg,epub,txt`) 
- `MAX_RESULTS`: Max search results to consider (default: `10`)

### Project Structure
```
app/
  main.py
  search.py
  llm.py
  downloader.py
  templates/
    base.html
    search.html
  static/
    style.css
```

### Disclaimer
This tool is intended for legitimate use only. Respect website terms and copyright laws.

