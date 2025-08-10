import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { URL } from 'url';
import { performance } from 'perf_hooks';
import net from 'net';
import tls from 'tls';
import crypto from 'crypto';

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
  const host = json.add || json.host;
  const port = Number(json.port || 443);
  const name = json.ps || `${host}:${port}`;
  const security = String(json.tls || json.security || '').toLowerCase();
  const isTls = security === 'tls' || security === 'reality';
  const network = String(json.net || json.network || '').toLowerCase() || 'tcp';
  const wsPath = json.path || json.wsPath || (json.wsSettings && json.wsSettings.path) || '';
  const wsHost = json.host || (json.wsSettings && json.wsSettings.headers && (json.wsSettings.headers.Host || json.wsSettings.headers.host));
  const sni = json.sni || json.serverName || (json.tlsSettings && json.tlsSettings.serverName) || undefined;
  const alpn = json.alpn || (json.tlsSettings && json.tlsSettings.alpn) || undefined;
  return host && port ? { scheme: 'vmess', host, port, name, isTls, security, network, wsPath, wsHost, sni, alpn, raw: uri } : null;
}

function parseShadowsocks(uri) {
  // ss://[method:password@]host:port#name  OR ss://base64(method:password@host:port)#name
  try {
    const withoutScheme = uri.replace(/^ss:\/\//i, '');
    let credsAndHost = withoutScheme;
    let name = '';
    const hashIdx = withoutScheme.indexOf('#');
    if (hashIdx >= 0) {
      name = decodeURIComponent(withoutScheme.slice(hashIdx + 1));
      credsAndHost = withoutScheme.slice(0, hashIdx);
    }
    let decoded = credsAndHost;
    if (!decoded.includes('@') && !decoded.includes(':')) {
      try {
        decoded = Buffer.from(decoded, 'base64').toString('utf-8');
      } catch {}
    }
    const atIdx = decoded.lastIndexOf('@');
    const hostPortStr = atIdx >= 0 ? decoded.slice(atIdx + 1) : decoded;
    const hp = hostPortStr.split(':');
    if (hp.length < 2) return null;
    const host = hp[0];
    const port = Number(hp[1]);
    return host && port ? { scheme: 'ss', host, port, name: name || `${host}:${port}`, isTls: false, network: 'tcp', raw: uri } : null;
  } catch {
    return null;
  }
}

function parseUrlLikeUri(uri) {
  // vless://, trojan:// with transport params, ss:// handled separately
  if (/^vless:\/\//i.test(uri) || /^trojan:\/\//i.test(uri)) {
    try {
      const u = new URL(uri);
      const host = u.hostname;
      const port = Number(u.port || 443);
      const name = decodeURIComponent(u.hash?.replace('#', '') || `${host}:${port}`);
      const security = (u.searchParams.get('security') || '').toLowerCase();
      const isTls = security === 'tls' || security === 'reality' || port === 443;
      const type = (u.searchParams.get('type') || '').toLowerCase();
      const wsPath = u.searchParams.get('path') || '';
      const wsHost = u.searchParams.get('host') || u.searchParams.get('Host') || '';
      const sni = u.searchParams.get('sni') || u.searchParams.get('serverName') || '';
      const alpn = u.searchParams.get('alpn') || '';
      const scheme = u.protocol.replace(':', '');
      return host ? { scheme, host, port, name, isTls, security, network: type || 'tcp', wsPath, wsHost, sni, alpn, raw: uri } : null;
    } catch {
      return null;
    }
  }
  if (/^ss:\/\//i.test(uri)) {
    return parseShadowsocks(uri);
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

async function timedWebSocketHandshakeProbe({ host, port, useTls, path = '/', hostHeader, servername, timeoutMs }) {
  return new Promise((resolve) => {
    const start = performance.now();
    const onDone = (ok, err) => resolve({ ok, ms: Math.round(performance.now() - start), error: err && String(err.message || err) });

    const key = crypto.randomBytes(16).toString('base64');
    const httpReq = `GET ${path || '/'} HTTP/1.1\r\n`
      + `Host: ${hostHeader || servername || host}\r\n`
      + `Upgrade: websocket\r\n`
      + `Connection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\n`
      + `Sec-WebSocket-Version: 13\r\n`
      + `User-Agent: Mozilla/5.0\r\n\r\n`;

    let socket;
    const onData = (chunk) => {
      const text = chunk.toString('utf-8');
      if (text.startsWith('HTTP/1.1 101') || text.startsWith('HTTP/1.0 101')) {
        cleanup();
        onDone(true);
      } else if (text.startsWith('HTTP/')) {
        cleanup();
        onDone(false, new Error(text.split('\r\n')[0]));
      }
    };
    const onError = (err) => { cleanup(); onDone(false, err); };
    const onTimeout = () => { cleanup(); onDone(false, new Error('timeout')); };
    const cleanup = () => {
      try { socket.off('data', onData); } catch {}
      try { socket.off('error', onError); } catch {}
      try { socket.setTimeout(0); } catch {}
      try { socket.end(); } catch {}
      try { socket.destroy(); } catch {}
    };

    try {
      if (useTls) {
        socket = tls.connect({ host, port, servername: servername || host, rejectUnauthorized: false }, () => {
          socket.write(httpReq);
        });
      } else {
        socket = net.connect({ host, port }, () => {
          socket.write(httpReq);
        });
      }
      socket.on('data', onData);
      socket.on('error', onError);
      socket.setTimeout(timeoutMs, onTimeout);
    } catch (err) {
      onDone(false, err);
    }
  });
}

async function probeSingleConfig(cfg, opts) {
  const { timeoutMs } = opts || {};
  const network = (cfg.network || '').toLowerCase();
  if (network === 'ws' || network === 'websocket') {
    return await timedWebSocketHandshakeProbe({
      host: cfg.host,
      port: cfg.port,
      useTls: !!cfg.isTls,
      path: cfg.wsPath || '/',
      hostHeader: cfg.wsHost || cfg.sni || cfg.host,
      servername: cfg.sni || cfg.wsHost || cfg.host,
      timeoutMs
    });
  }
  return await timedTcpOrTlsProbe({ host: cfg.host, port: cfg.port, servername: cfg.sni || cfg.host, useTls: !!cfg.isTls, timeoutMs });
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
        probeSingleConfig(cfg, { timeoutMs })
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