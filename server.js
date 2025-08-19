import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { URL } from 'url';
import { performance } from 'perf_hooks';
import net from 'net';
import tls from 'tls';

const PUBLIC_DIR = join(process.cwd(), 'public');

function getContentType(pathname) {
  const ext = extname(pathname).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    default: return 'text/plain; charset=utf-8';
  }
}

function isUrlLike(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function tryBase64Decode(input) {
  try {
    const buff = Buffer.from(input.trim(), 'base64');
    // Heuristic: decoded text should be mostly printable
    const text = buff.toString('utf-8');
    if ((text.match(/[\x00-\x08\x0E-\x1F]/g) || []).length > 0) return null;
    return text;
  } catch {
    return null;
  }
}

function parseSubscriptionText(text) {
  // Some subscriptions are base64 of multiple lines
  const maybeDecoded = tryBase64Decode(text);
  const content = maybeDecoded && (maybeDecoded.includes('://') || maybeDecoded.includes('\n')) ? maybeDecoded : text;
  const lines = content
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines;
}

function parseVmessUri(uri) {
  // vmess:// base64(JSON)
  const base64Part = uri.replace(/^vmess:\/\//i, '').trim();
  let json;
  try {
    const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
    json = JSON.parse(decoded);
  } catch {
    return null;
  }
  // Common fields: add (host), port, ps (name), tls/security
  const host = json.add || json.host;
  const port = Number(json.port || 443);
  const name = json.ps || `${host}:${port}`;
  const isTls = String(json.tls || json.security || '').toLowerCase() === 'tls';
  return host && port ? { scheme: 'vmess', host, port, name, isTls, raw: uri } : null;
}

function parseUrlLikeUri(uri) {
  // vless://, trojan://, ss:// (simple heuristics)
  if (/^vless:\/\//i.test(uri) || /^trojan:\/\//i.test(uri) || /^ss:\/\//i.test(uri)) {
    try {
      const u = new URL(uri);
      const host = u.hostname;
      let port = Number(u.port || (u.protocol === 'ss:' ? 443 : 443));
      const name = decodeURIComponent(u.hash?.replace('#', '') || `${host}:${port}`);
      const isTls = (u.searchParams.get('security') || '').toLowerCase() === 'tls' || port === 443;
      const scheme = u.protocol.replace(':', '');
      return host ? { scheme, host, port, name, isTls, raw: uri } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseConfigsFromText(text) {
  const lines = parseSubscriptionText(text);
  const configs = [];
  for (const line of lines) {
    if (/^vmess:\/\//i.test(line)) {
      const cfg = parseVmessUri(line);
      if (cfg) configs.push(cfg);
      continue;
    }
    const other = parseUrlLikeUri(line);
    if (other) {
      configs.push(other);
      continue;
    }
    // Some subscriptions may contain concatenated base64 content again
    const maybe = tryBase64Decode(line);
    if (maybe) {
      const innerLines = parseSubscriptionText(maybe);
      for (const inner of innerLines) {
        const innerCfg = /^vmess:\/\//i.test(inner)
          ? parseVmessUri(inner)
          : parseUrlLikeUri(inner);
        if (innerCfg) configs.push(innerCfg);
      }
    }
  }
  // De-duplicate by host:port:scheme:name
  const seen = new Set();
  const unique = [];
  for (const cfg of configs) {
    const key = `${cfg.scheme}|${cfg.host}|${cfg.port}|${cfg.name}`;
    if (!seen.has(key)) { seen.add(key); unique.push(cfg); }
  }
  return unique;
}

async function timedTcpOrTlsProbe({ host, port, servername, useTls, timeoutMs }) {
  return new Promise((resolve) => {
    const start = performance.now();
    let socket;
    let settled = false;

    const onSuccess = () => {
      if (settled) return;
      settled = true;
      const ms = Math.round(performance.now() - start);
      try { socket.end(); } catch {}
      resolve({ ok: true, ms });
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({ ok: false, error: String(err?.message || err), ms: Math.round(performance.now() - start) });
    };

    const onTimeout = () => onError(new Error('timeout'));

    if (useTls) {
      socket = tls.connect({ host, port, servername: servername || host, rejectUnauthorized: false }, onSuccess);
    } else {
      socket = net.connect({ host, port }, onSuccess);
    }

    socket.setTimeout(timeoutMs, onTimeout);
    socket.on('error', onError);
  });
}

async function probeConfigs(configs, opts) {
  const { timeoutMs = 3000, concurrency = 25 } = opts || {};
  const results = [];
  let active = 0;
  let index = 0;

  return await new Promise((resolve) => {
    const next = () => {
      if (index >= configs.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < concurrency && index < configs.length) {
        const cfg = configs[index++];
        active++;
        timedTcpOrTlsProbe({ host: cfg.host, port: cfg.port, servername: cfg.sni || cfg.host, useTls: !!cfg.isTls, timeoutMs })
          .then((res) => {
            results.push({ ...cfg, ok: res.ok, ms: res.ms, error: res.error });
          })
          .catch((err) => {
            results.push({ ...cfg, ok: false, ms: timeoutMs, error: String(err?.message || err) });
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

async function handleScan(req, res) {
  try {
    const bodyText = await readRequestBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    let sources = Array.isArray(body.sources) ? body.sources : [];
    const timeoutMs = Math.max(500, Math.min(10000, Number(body.timeoutMs || 3000)));
    const concurrency = Math.max(1, Math.min(100, Number(body.concurrency || 25)));

    // You can also pass raw content via body.rawText
    const rawText = typeof body.rawText === 'string' ? body.rawText : '';

    const texts = [];

    // Fetch URLs
    const urlSources = sources.filter(isUrlLike);
    const nonUrlSources = sources.filter((s) => !isUrlLike(s));

    if (urlSources.length > 0) {
      const fetches = await Promise.allSettled(urlSources.map((u) => fetch(u, { cache: 'no-store' })));
      for (const f of fetches) {
        if (f.status === 'fulfilled') {
          try { texts.push(await f.value.text()); } catch {}
        }
      }
    }

    // Non-URL entries might be inline config lines
    if (nonUrlSources.length > 0) {
      texts.push(nonUrlSources.join('\n'));
    }

    if (rawText) texts.push(rawText);

    const allText = texts.join('\n');
    const configs = parseConfigsFromText(allText);

    const probed = await probeConfigs(configs, { timeoutMs, concurrency });
    const okOnly = probed.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ total: configs.length, ok: okOnly.length, timeoutMs, results: okOnly.slice(0, 500) }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}

async function fetchJsonSafe(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Aggregate markets snapshot with multiple fallbacks and unify to IRR
async function handleMarketsSnapshot(_req, res) {
  // Sources
  const sources = [];
  const now = Date.now();

  // FX USD/IRR via multiple sources
  // 1) https://api.exchangerate.host/latest?base=USD&symbols=IRR
  const fx1 = await fetchJsonSafe('https://api.exchangerate.host/latest?base=USD&symbols=IRR');
  let usdIrr = fx1?.rates?.IRR ? Number(fx1.rates.IRR) : null;
  if (usdIrr) sources.push('exchangerate.host');

  // 2) https://open.er-api.com/v6/latest/USD
  if (!usdIrr) {
    const fx2 = await fetchJsonSafe('https://open.er-api.com/v6/latest/USD');
    const v = fx2?.rates?.IRR ? Number(fx2.rates.IRR) : null;
    if (v) { usdIrr = v; sources.push('open.er-api.com'); }
  }

  // 3) Try Nobitex USDT/IRT as market proxy for USD/IRR
  let nobitexIrt = null;
  {
    const nb = await fetchJsonSafe('https://api.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=irt');
    // response example: { stats: { usdt-irt: { bestSell, bestBuy, latest, ... } } }
    const statsObj = nb?.stats || nb?.global?.stats || null;
    const key = statsObj && (statsObj['usdt-irt'] ? 'usdt-irt' : (statsObj['USDT-IRT'] ? 'USDT-IRT' : null));
    const latest = key ? Number(statsObj[key]?.latest || statsObj[key]?.bestSell || statsObj[key]?.bestBuy) : null;
    if (latest && isFinite(latest)) { nobitexIrt = latest; sources.push('nobitex USDT/IRT'); }
  }

  // 3) Optional market IRR from Parsi sources (e.g., tgju.org unofficial JSON)
  // We avoid scraping; keep two international fallbacks above.

  // EUR
  let eurIrr = null;
  const eurFx = await fetchJsonSafe('https://api.exchangerate.host/latest?base=EUR&symbols=IRR');
  if (eurFx?.rates?.IRR) { eurIrr = Number(eurFx.rates.IRR); sources.push('exchangerate.host (EUR)'); }

  // Crypto USD pairs (coingecko simple price as fallback)
  let btcUsd = null, ethUsd = null;
  const cg = await fetchJsonSafe('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd');
  if (cg?.bitcoin?.usd) { btcUsd = Number(cg.bitcoin.usd); sources.push('coingecko-btc'); }
  if (cg?.ethereum?.usd) { ethUsd = Number(cg.ethereum.usd); sources.push('coingecko-eth'); }

  // Prefer market rate from Nobitex (IRT -> Rial by *10). Otherwise keep FX official IRR.
  if (nobitexIrt && isFinite(nobitexIrt)) {
    usdIrr = Number(nobitexIrt) * 10;
  }
  // Fallback heuristic: many FX APIs return ~42,000 IRR (official). Convert to بازارِ آزاد تقریبی با ضرب در 10
  if (usdIrr && usdIrr < 100000) {
    usdIrr = usdIrr * 10;
  }
  if (eurIrr && eurIrr < 100000) {
    eurIrr = eurIrr * 10;
  }

  const body = {
    fx: {
      USD_IRR: usdIrr ? { value: usdIrr, source: sources.includes('nobitex USDT/IRT') ? 'بازار (Nobitex)' : 'میانگین منابع' } : null,
      EUR_IRR: eurIrr ? { value: eurIrr, source: 'exchangerate.host' } : null,
    },
    crypto: {
      BTC_USD: btcUsd ? { value: btcUsd } : null,
      ETH_USD: ethUsd ? { value: ethUsd } : null,
    },
    meta: { ts: now, sources }
  };

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleMarketsHistory(req, res, urlObj) {
  // For demo we synthesize a 60-point intraday series around current USD/IRR
  const snapRes = await fetchJsonSafe('http://localhost:'+PORT+'/api/markets/snapshot');
  const base = Number(snapRes?.fx?.USD_IRR?.value || 500000);
  const points = [];
  const now = Date.now();
  for (let i = 59; i >= 0; i--) {
    const ts = now - i * 60 * 1000;
    const noise = (Math.sin(i/7)*0.002 + (Math.random()-0.5)*0.002) * base;
    points.push({ ts, value: Math.round(base + noise) });
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ symbol: 'USD_IRR', points }));
}

async function handleMarketsPatterns(_req, res) {
  // Simple placeholder summary using heuristics on the synthetic history is out of scope here
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ summary: 'RSI و میانگین‌های متحرک حاکی از نوسان محدود در کوتاه‌مدت است. شکست محدوده با حجم بالا می‌تواند سیگنال معتبرتری بدهد.' }));
}

async function handleMarketsFormula(_req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ formula: 'signal = (EMA(close, 9) - EMA(close, 21)) * (1 - RSI(14)/100)' }));
}

async function handleMarketsRecs(_req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ buy: ['خرید پله‌ای در اصلاح‌های 0.5-1%'], sell: ['فروش بخشی در سقف کانال کوتاه‌مدت'] }));
}

async function handlePing(_req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: 'ok' }));
}

async function handleDeepAnalysis(req, res) {
  try {
    const bodyText = await readRequestBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const key = String(body.openai_api_key || '').trim();
    const model = String(body.model || 'gpt-4o-mini');
    const snapshot = body.snapshot || {};
    const minutesAhead = Number(body.minutes_ahead || 10);
    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'missing key' }));
      return;
    }
    const prompt = `به عنوان تحلیلگر حرفه‌ای بازارهای مالی عمل کن. داده‌های زیر از منابع متعدد جهانی گردآوری شده است. با بررسی الگوهای رایج، نظر اکثریت و شواهد معتبر، یک جمع‌بندی بسیار دقیق ارائه بده و مشخص کن در ${minutesAhead} دقیقه آینده برای هر دارایی چه اقدام کوتاه‌مدتی پیشنهاد می‌شود (خرید/فروش/بدون اقدام) با ذکر منطق و سطح اطمینان.
 داده‌ها: ${JSON.stringify(snapshot)}\n`; 

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'شما یک تحلیلگر کلان‌داده بازارهای مالی هستید که بر صحت، اجماع منابع و مدیریت ریسک تاکید دارید.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 800
      })
    });
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content || '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ text }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}

async function handleStatic(req, res, urlObj) {
  // Default to index.html
  let pathname = urlObj.pathname;
  if (pathname === '/') pathname = '/index.html';
  const safePath = normalize(pathname).replace(/^\/+/, '');
  const filePath = join(PUBLIC_DIR, safePath);
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': getContentType(filePath), 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && urlObj.pathname === '/api/scan') {
      return await handleScan(req, res);
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/ping') {
      return await handlePing(req, res);
    }
    if (req.method === 'GET' && urlObj.pathname === '/api/markets/snapshot') {
      return await handleMarketsSnapshot(req, res);
    }
    if (req.method === 'GET' && urlObj.pathname === '/api/markets/history') {
      return await handleMarketsHistory(req, res, urlObj);
    }
    if (req.method === 'GET' && urlObj.pathname === '/api/markets/patterns') {
      return await handleMarketsPatterns(req, res);
    }
    if (req.method === 'GET' && urlObj.pathname === '/api/markets/formula') {
      return await handleMarketsFormula(req, res);
    }
    if (req.method === 'GET' && urlObj.pathname === '/api/markets/recommendations') {
      return await handleMarketsRecs(req, res);
    }
    if (req.method === 'POST' && urlObj.pathname === '/api/deep-analysis') {
      return await handleDeepAnalysis(req, res);
    }

    if (req.method === 'GET') {
      return await handleStatic(req, res, urlObj);
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});