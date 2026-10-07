import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://karlconwaymusic-creator.github.io';
const ENV = { SPOTIFY_CLIENT_ID: 'dummy-id', SPOTIFY_CLIENT_SECRET: 'dummy-secret', ALLOWED_ORIGINS: ORIGIN };
const ALBUM = '4ZYnr7sAQw83pQxf0l72JB';
const realFetch = globalThis.fetch;
let n = 0;

// Fresh module (fresh token cache) per test, with a scripted fake Spotify.
async function setup(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls);
  };
  const mod = await import(`../src/index.js?t=${n++}`);
  return { worker: mod.default, calls };
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const tokenOk = (expires = 3600) => new Response(JSON.stringify({ access_token: 'tok', expires_in: expires }), { status: 200 });
const req = (path, init = {}) => new Request('https://w.example' + path, { headers: { Origin: ORIGIN }, ...init });

test('album: fetches token, proxies Spotify body, sets CORS', async () => {
  const { worker, calls } = await setup(url =>
    url.includes('accounts.spotify.com') ? tokenOk() : new Response(JSON.stringify({ name: 'Berlin, Berlin' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const res = await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'Berlin, Berlin' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(calls[1].url, 'https://api.spotify.com/v1/albums/' + ALBUM);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + btoa('dummy-id:dummy-secret'));
});

test('token is cached across requests until it expires', async () => {
  const { worker, calls } = await setup(url => (url.includes('accounts.spotify.com') ? tokenOk() : new Response('{}', { status: 200 })));
  await worker.fetch(req('/album/' + ALBUM), ENV);
  await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(calls.filter(c => c.url.includes('accounts.spotify.com')).length, 1);
});

test('expired token is refreshed', async () => {
  const { worker, calls } = await setup(url => (url.includes('accounts.spotify.com') ? tokenOk(30) : new Response('{}', { status: 200 })));
  await worker.fetch(req('/album/' + ALBUM), ENV); // expires_in 30 < 60s margin -> already stale
  await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(calls.filter(c => c.url.includes('accounts.spotify.com')).length, 2);
});

test('concurrent requests share one token fetch', async () => {
  const { worker, calls } = await setup(async url => {
    if (url.includes('accounts.spotify.com')) { await new Promise(r => setTimeout(r, 20)); return tokenOk(); }
    return new Response('{}', { status: 200 });
  });
  await Promise.all([1, 2, 3].map(() => worker.fetch(req('/album/' + ALBUM), ENV)));
  assert.equal(calls.filter(c => c.url.includes('accounts.spotify.com')).length, 1);
});

test('a 401 from Spotify triggers one token refresh and retry', async () => {
  let apiHits = 0;
  const { worker, calls } = await setup(url => {
    if (url.includes('accounts.spotify.com')) return tokenOk();
    return ++apiHits === 1 ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
  const res = await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(res.status, 200);
  assert.equal(calls.filter(c => c.url.includes('accounts.spotify.com')).length, 2);
});

test('Spotify 429 passes through with Retry-After exposed to the browser', async () => {
  const { worker } = await setup(url =>
    url.includes('accounts.spotify.com') ? tokenOk() : new Response('{"error":{"status":429}}', { status: 429, headers: { 'Retry-After': '17' } }));
  const res = await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '17');
  assert.match(res.headers.get('Access-Control-Expose-Headers'), /Retry-After/);
});

test('Spotify 404 passes through unchanged', async () => {
  const { worker } = await setup(url => (url.includes('accounts.spotify.com') ? tokenOk() : new Response('{"error":{"status":404}}', { status: 404 })));
  const res = await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { status: 404 } });
});

test('token endpoint failure -> clean 502, no crash', async () => {
  const { worker } = await setup(() => new Response('{"error":"invalid_client"}', { status: 400 }));
  const res = await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'spotify_auth_failed', upstreamStatus: 400, upstreamError: 'invalid_client' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('token endpoint 429 -> 429 with Retry-After', async () => {
  const { worker } = await setup(() => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }));
  const res = await worker.fetch(req('/album/' + ALBUM), ENV);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '30');
});

test('network failure -> 502; timeout -> 504', async () => {
  let { worker } = await setup(() => { throw new TypeError('fetch failed'); });
  assert.equal((await worker.fetch(req('/album/' + ALBUM), ENV)).status, 502);
  ({ worker } = await setup(() => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }));
  assert.equal((await worker.fetch(req('/album/' + ALBUM), ENV)).status, 504);
});

test('missing secrets -> 500 worker_not_configured', async () => {
  const { worker, calls } = await setup(() => tokenOk());
  const res = await worker.fetch(req('/album/' + ALBUM), { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'worker_not_configured' });
  assert.equal(calls.length, 0);
});

test('search: builds Spotify query, clamps limit, validates q', async () => {
  const { worker, calls } = await setup(url => (url.includes('accounts.spotify.com') ? tokenOk() : new Response('{"albums":{"items":[]}}', { status: 200 })));
  const res = await worker.fetch(req('/search?q=Fionn%20Regan%20Berlin&limit=999'), ENV);
  assert.equal(res.status, 200);
  const u = new URL(calls[1].url);
  assert.equal(u.pathname, '/v1/search');
  assert.equal(u.searchParams.get('q'), 'Fionn Regan Berlin');
  assert.equal(u.searchParams.get('type'), 'album');
  assert.equal(u.searchParams.get('limit'), '50');
  assert.equal((await worker.fetch(req('/search'), ENV)).status, 400);
  assert.equal((await worker.fetch(req('/search?q=' + 'x'.repeat(201)), ENV)).status, 400);
});

test('album id is validated (no path injection)', async () => {
  const { worker, calls } = await setup(() => tokenOk());
  for (const bad of ['short', '..%2Fme', 'abc%20def1234567', 'a'.repeat(40)]) {
    assert.equal((await worker.fetch(req('/album/' + bad), ENV)).status, 400, bad);
  }
  assert.equal(calls.length, 0);
});

test('CORS: wrong or missing origin is refused, nothing upstream is called', async () => {
  const { worker, calls } = await setup(() => tokenOk());
  for (const headers of [{ Origin: 'https://evil.example' }, {}, { Origin: ORIGIN + '.evil.example' }]) {
    const res = await worker.fetch(new Request('https://w.example/album/' + ALBUM, { headers }), ENV);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(calls.length, 0);
});

test('CORS preflight: allowed origin -> 204 with headers; other -> 403', async () => {
  const { worker } = await setup(() => tokenOk());
  const ok = await worker.fetch(new Request('https://w.example/album/' + ALBUM, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), ENV);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const no = await worker.fetch(new Request('https://w.example/album/' + ALBUM, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), ENV);
  assert.equal(no.status, 403);
});

test('non-GET methods and unknown routes', async () => {
  const { worker } = await setup(() => tokenOk());
  assert.equal((await worker.fetch(req('/album/' + ALBUM, { method: 'POST' }), ENV)).status, 405);
  assert.equal((await worker.fetch(req('/nope'), ENV)).status, 404);
});

test('the client secret never appears in any response', async () => {
  const { worker } = await setup(url => (url.includes('accounts.spotify.com') ? new Response('{}', { status: 400 }) : tokenOk()));
  for (const p of ['/album/' + ALBUM, '/search?q=a', '/nope']) {
    const res = await worker.fetch(req(p), ENV);
    const text = await res.text() + JSON.stringify([...res.headers]);
    assert.ok(!text.includes('dummy-secret') && !text.includes(btoa('dummy-id:dummy-secret')));
  }
});
