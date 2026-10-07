// LPQ Spotify proxy. Holds the Spotify client credentials (Worker secrets
// SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET), does the client-credentials token
// fetch itself, and exposes two read-only endpoints to the LPQ app:
//   GET /album/:id          -> Spotify GET /v1/albums/:id   (body passed through)
//   GET /search?q=&limit=   -> Spotify GET /v1/search?type=album
// Only origins listed in ALLOWED_ORIGINS (comma-separated) are served.

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const UPSTREAM_TIMEOUT_MS = 8000;
const ALBUM_ID_RE = /^[A-Za-z0-9]{10,32}$/;

// Per-isolate token cache. A cold isolate just fetches a fresh token.
let cachedToken = null; // { value, expiresAt }
let tokenInflight = null;

class UpstreamError extends Error {
  constructor(status, body, retryAfter) {
    super(`upstream ${status}`);
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // The app reads Retry-After to pause its background fetches on a 429.
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

async function fetchToken(env) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw new UpstreamError(500, { error: 'worker_not_configured' });
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Spotify's reason (e.g. "invalid_client") — never contains the credentials.
    let reason = null;
    try { const j = await res.json(); reason = j.error_description || j.error || null; } catch {}
    throw new UpstreamError(res.status === 429 ? 429 : 502, { error: 'spotify_auth_failed', upstreamStatus: res.status, upstreamError: reason }, res.headers.get('Retry-After'));
  }
  const data = await res.json();
  // Refresh 60s early, same margin the app used.
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function getToken(env, forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  if (!tokenInflight) tokenInflight = fetchToken(env).finally(() => { tokenInflight = null; });
  return tokenInflight;
}

// GET a Spotify API path with the cached token; retries once with a fresh
// token if Spotify says the cached one is no longer valid.
async function spotifyGet(env, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(env, attempt > 0);
    const res = await fetch(API_BASE + path, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 401 && attempt === 0) { cachedToken = null; continue; }
    return res;
  }
}

async function handle(request, env, origin) {
  const url = new URL(request.url);
  const cors = corsHeaders(origin);
  let path;

  const albumMatch = url.pathname.match(/^\/album\/([^/]+)$/);
  if (albumMatch) {
    if (!ALBUM_ID_RE.test(albumMatch[1])) return json({ error: 'invalid_album_id' }, 400, cors);
    path = `/albums/${albumMatch[1]}`;
  } else if (url.pathname === '/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q || q.length > 200) return json({ error: 'invalid_query' }, 400, cors);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 50);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
    path = `/search?${new URLSearchParams({ q, type: 'album', limit: String(limit), offset: String(offset) })}`;
  } else {
    return json({ error: 'not_found' }, 404, cors);
  }

  let res;
  try {
    res = await spotifyGet(env, path);
  } catch (err) {
    if (err instanceof UpstreamError) {
      const extra = err.retryAfter ? { 'Retry-After': err.retryAfter } : {};
      return json(err.body, err.status, { ...cors, ...extra });
    }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return json({ error: timedOut ? 'spotify_timeout' : 'spotify_unreachable' }, timedOut ? 504 : 502, cors);
  }

  // Pass Spotify's status and body straight through (404s, 429s and all) so
  // the app's existing res.ok / res.status handling behaves as it did before.
  const headers = { 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store', ...cors };
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) headers['Retry-After'] = retryAfter;
  return new Response(await res.text(), { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = origin && allowedOrigins(env).includes(origin);

    if (request.method === 'OPTIONS') {
      return allowed ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : json({ error: 'origin_not_allowed' }, 403);
    }
    if (!allowed) return json({ error: 'origin_not_allowed' }, 403);
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { ...corsHeaders(origin), Allow: 'GET, OPTIONS' });

    try {
      return await handle(request, env, origin);
    } catch (err) {
      console.error('unhandled', err?.message || err);
      return json({ error: 'internal_error' }, 500, corsHeaders(origin));
    }
  },
};
