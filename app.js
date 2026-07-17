'use strict';

const APP_VERSION = 'v50'; // bump alongside sw.js CACHE and the ?v= query strings in index.html

// ─── State ────────────────────────────────────────────────────────────────────
let albums = [];
let pendingContextId = null;
let currentView = 'shelf';
let fetchedAlbum = null;
let lookupSeq = 0; // monotonic token — a URL lookup only applies if still current when it resolves

const MAX_ALBUMS = 20; // hard ceiling; user limit is settings.shelfSize

// ─── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
  archiveOnRemove: true,
  shelfSize:       12,
  shopUrl:         'https://towerrecords.ie/search?q=',
};
let settings = { ...SETTINGS_DEFAULTS };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('lpq-settings') || 'null');
    if (saved) settings = { ...SETTINGS_DEFAULTS, ...saved };
  } catch {}
}

function saveSettings() {
  localStorage.setItem('lpq-settings', JSON.stringify(settings));
}

// Promote pre-release albums whose release date has now passed.
// Only acts when we have a confirmed release date — albums with no date stay
// in Pre-Releases until the date is known (backfill) or they're manually moved.
function checkPreReleases() {
  let changed = false;
  for (const a of albums) {
    // Expire ghost cards (shelf placeholders for releases archived on a full shelf)
    if (a.ghostUntil && Date.now() >= a.ghostUntil) {
      delete a.ghostUntil;
      changed = true;
    }
    if (!a.preRelease) continue;
    // Never auto-promote if we don't have a date to check against
    if (!a.releaseDate && !a.spotifyUrl?.includes('/prerelease/')) continue;
    if (!isPreRelease(a.releaseDate, a.spotifyUrl)) {
      // Check shelf capacity before marking as released (before it counts toward the shelf)
      const shelfFull = albums.filter(
        x => !x.archived && !x.preRelease && !x.detached
      ).length >= settings.shelfSize;
      a.preRelease = false;
      if (shelfFull) {
        // No room — archive it, but leave a 7-day ghost card on the shelf
        a.archived   = true;
        a.ghostUntil = Date.now() + 7 * 24 * 60 * 60 * 1000;
      }
      changed = true;
    }
  }
  if (changed) save();
}

// Silently fetch release years / dates for albums that pre-date those features.
// Pre-release albums are skipped — oEmbed never returns year for unreleased content.
// Runs with a 300 ms gap between requests to stay well under Spotify's rate limit.
// Record labels are NOT fetched here — Spotify's catalog API returns label:null
// for every album regardless of how well-documented it is (confirmed by direct
// testing), so label lookups go through MusicBrainz instead — see backfillLabels().
async function backfillYears() {
  if (isRateLimited()) return; // respect persisted rate-limit window
  const needsData = albums.filter(a =>
    a.spotifyUrl &&
    !a.spotifyUrl.includes('/prerelease/') &&
    (!a.year || !a.releaseDate)
  );
  if (!needsData.length) return;
  let changed = false;
  for (const a of needsData) {
    if (isRateLimited()) break; // stop mid-loop if we hit the limit
    await new Promise(r => setTimeout(r, 300)); // pace requests — avoid 429
    try {
      const id = extractAlbumId(a.spotifyUrl);
      if (!id) continue;
      const token = await getSpotifyToken();
      const res = await fetch(`https://api.spotify.com/v1/albums/${id}`, {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '7200', 10);
          setRateLimit(Date.now() + retryAfter * 1000);
          break; // must stop on rate limit
        }
        continue; // 404 / other error — skip this album, keep going
      }
      const d = await res.json();
      if (d.release_date && !a.year)        { a.year = d.release_date.slice(0, 4); changed = true; }
      if (d.release_date && !a.releaseDate) { a.releaseDate = d.release_date;      changed = true; }
    } catch (err) {
      console.warn('[LPQ] backfillYears failed for', a.title, err);
    }
  }
  if (changed) { save(); render(); }
}

// ─── MusicBrainz (record label lookup) ─────────────────────────────────────────
// Public API, no key required, but rate-limited to ~1 request/second.
// mbThrottle() enforces a minimum gap between calls across the whole app.
let mbLastCall = 0;
async function mbThrottle() {
  const wait = Math.max(0, 1100 - (Date.now() - mbLastCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  mbLastCall = Date.now();
}

async function fetchLabelFromMusicBrainz(artist, title) {
  if (!artist || !title) return '';
  await mbThrottle();
  try {
    const query = `artist:"${artist.replace(/"/g, '')}" AND release:"${title.replace(/"/g, '')}"`;
    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const d = await res.json();
    const withLabel = (d.releases || []).find(r => r['label-info']?.[0]?.label?.name);
    return withLabel?.['label-info'][0].label.name || '';
  } catch (err) {
    console.warn('[LPQ] MusicBrainz label lookup failed for', title, err);
    return '';
  }
}

// Background pass to backfill labels for albums missing one. Runs after
// backfillYears so artist/title are already populated. One request per
// second via mbThrottle — slow on purpose to respect MusicBrainz's public API.
async function backfillLabels() {
  const needsLabel = albums.filter(a => a.label == null && a.artist && a.title);
  if (!needsLabel.length) return;
  let changed = false;
  for (const a of needsLabel) {
    a.label = await fetchLabelFromMusicBrainz(a.artist, a.title); // '' if no match
    changed = true;
    save(); // save incrementally so progress isn't lost if interrupted
    if (pendingContextId === a.id) $ctxArtist.textContent = buildCtxSub(a);
  }
  if (changed) render();
}

// ─── Wikipedia ─────────────────────────────────────────────────────────────────
// Search "TITLE ARTIST album" and return the direct article URL of the top hit.
async function findWikipediaUrl(a) {
  const query = `${a.title} ${a.artist} album`;
  const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search' +
    `&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const d = await res.json();
  const top = d.query?.search?.[0];
  if (!top) return null;
  return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(top.title.replace(/ /g, '_'));
}

function applySettingsUI() {
  $settingArchive.checked    = settings.archiveOnRemove;
  $settingShelfSize.value    = settings.shelfSize;
  $shelfSizeVal.textContent  = settings.shelfSize;
  $settingShopUrl.value      = settings.shopUrl;
  const $version = document.getElementById('appVersion');
  if ($version) $version.textContent = 'LPQ ' + APP_VERSION;
}

// ─── Spotify ──────────────────────────────────────────────────────────────────
const SP_ID     = '1978c65fadff4963ab3373a4f4be8afb';
const SP_SECRET = '8b15acf967734155a7b658740551554d';
let spToken  = null;
let spExpiry = 0;

async function getSpotifyToken() {
  if (spToken && Date.now() < spExpiry) return spToken;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(SP_ID + ':' + SP_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Auth failed');
  const data = await res.json();
  spToken  = data.access_token;
  spExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spToken;
}

function extractAlbumId(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const i = parts.findIndex(p => p === 'album' || p === 'prerelease');
    if (i !== -1 && parts[i + 1]) return parts[i + 1].split('?')[0];
  } catch {}
  return null;
}

async function fetchSpotifyAlbum(albumId, rawUrl) {
  // /prerelease/ IDs are never in the catalog (always 404), so skip the
  // catalog round-trips entirely: scrape the embed page (artist, date,
  // 640px art) with oEmbed in parallel as a title/thumbnail safety net.
  if (rawUrl.includes('/prerelease/')) {
    const [meta, oe] = (await Promise.allSettled([
      fetchPreReleaseMeta(rawUrl),
      fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(rawUrl))
        .then(r => (r.ok ? r.json() : null)),
    ])).map(r => (r.status === 'fulfilled' ? r.value : null));

    if (meta && (meta.artist || meta.releaseDate)) {
      return {
        title:       meta.title || oe?.title,
        artist:      meta.artist || '',
        art:         meta.art || oe?.thumbnail_url || null,
        spotifyUrl:  rawUrl.split('?')[0],
        year:        meta.releaseDate ? meta.releaseDate.slice(0, 4) : null,
        releaseDate: meta.releaseDate,
        label:       null,
      };
    }
    if (!oe?.title) throw new Error('Album not found');
    return {
      title:         oe.title,
      artist:        oe.author_name || '',
      art:           oe.thumbnail_url ?? null,
      spotifyUrl:    rawUrl.split('?')[0],
      year:          null,
      releaseDate:   null,
      label:         null,
      partialLookup: true, // scrape failed — artist/date need manual entry
    };
  }

  // Try the catalog API first — gives high-res art and full metadata
  try {
    const token = await getSpotifyToken();
    const res = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.ok) {
      const d = await res.json();
      return {
        title:       d.name,
        artist:      d.artists.map(a => a.name).join(', '),
        art:         d.images[0]?.url ?? null,
        spotifyUrl:  d.external_urls.spotify,
        year:        d.release_date ? d.release_date.slice(0, 4) : null,
        releaseDate: d.release_date ?? null,
        label:       d.label ?? null,
      };
    }
  } catch {}

  // Fall back to oEmbed — works for pre-releases not yet in the catalog
  const oe = await fetch(
    'https://open.spotify.com/oembed?url=' + encodeURIComponent(rawUrl)
  );
  if (!oe.ok) throw new Error('Album not found');
  const d = await oe.json();

  // oEmbed html contains an embed iframe — try to extract a catalog-resolvable ID.
  // Spotify may use /embed/album/ or /embed/prerelease/ in the src.
  console.log('[LPQ] oEmbed html:', d.html);
  const embedId = ((d.html || '').match(/open\.spotify\.com\/embed\/(?:album|prerelease)\/([A-Za-z0-9]+)/) || [])[1];
  if (embedId) {
    try {
      const token = await getSpotifyToken();
      const res2 = await fetch(`https://api.spotify.com/v1/albums/${embedId}`, {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res2.ok) {
        const cd = await res2.json();
        return {
          title:       cd.name,
          artist:      cd.artists.map(a => a.name).join(', '),
          art:         cd.images[0]?.url ?? null,
          spotifyUrl:  cd.external_urls.spotify,
          year:        cd.release_date ? cd.release_date.slice(0, 4) : null,
          releaseDate: cd.release_date ?? null,
          label:       cd.label ?? null,
        };
      } else {
        console.log('[LPQ] catalog retry failed:', res2.status, 'embedId:', embedId);
      }
    } catch (err) {
      console.log('[LPQ] catalog retry error:', err);
    }
  } else {
    console.log('[LPQ] no embed ID found in oEmbed html');
  }

  // Genuine fallback — album truly not in catalog yet
  return {
    title:         d.title,
    artist:        d.author_name || '',
    art:           d.thumbnail_url ?? null,
    spotifyUrl:    rawUrl.split('?')[0],
    year:          null,
    releaseDate:   null,
    label:         null,
    partialLookup: true, // flag: only title+art retrieved; artist/date need manual entry
  };
}

// ─── Pre-release metadata scrape ──────────────────────────────────────────────
// open.spotify.com/embed/prerelease/{id} embeds a __NEXT_DATA__ JSON blob with
// entity.subtitle (artist), entity.releaseDate.isoString and full-size art.
// The page itself sends no CORS headers, so a direct fetch only works if
// Spotify ever relaxes that — we fall back to public CORS relays.
async function fetchPreReleaseMeta(prereleaseUrl) {
  const id = extractAlbumId(prereleaseUrl);
  if (!id) return null;
  const embedUrl = 'https://open.spotify.com/embed/prerelease/' + id;
  // Each attempt gets a hard timeout so one slow relay can't stall the lookup.
  const t = () => AbortSignal.timeout(4000);
  const attempts = [
    // 1. Direct — near-instant fail on CORS, future-proof if Spotify opens it
    async () => (await fetch(embedUrl, { signal: t() })).text(),
    // 2. corsproxy.io — fastest relay in live browser testing
    async () => (await fetch('https://corsproxy.io/?url=' + encodeURIComponent(embedUrl), { signal: t() })).text(),
    // 3. allorigins JSON wrapper — slower and flakier, last resort
    async () => {
      const r = await fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(embedUrl), { signal: t() });
      return (await r.json()).contents;
    },
  ];
  for (const attempt of attempts) {
    try {
      const html = await attempt();
      if (!html) continue;
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) continue;
      const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
      if (!entity) continue;
      const iso = entity.releaseDate?.isoString || null;
      const images = entity.visualIdentity?.image || [];
      const art = images.slice().sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0]?.url || null;
      return {
        title:       entity.title || entity.name || null,
        artist:      entity.subtitle || null,
        // isoString is the release INSTANT in UTC (midnight local can be the
        // previous day in UTC) — convert to the device's local calendar date,
        // never slice the raw string, or albums promote a day early.
        releaseDate: iso ? localISODate(new Date(iso)) : null,
        art,
      };
    } catch (err) {
      console.log('[LPQ] prerelease meta attempt failed:', err?.message || err);
    }
  }
  return null;
}

// Refresh artist / release date for every pre-release with a /prerelease/ URL,
// once per boot. Always re-scrapes rather than only filling gaps: it corrects
// dates stored a day early by the old UTC-slicing bug, and picks up release
// dates Spotify has shifted since the album was added.
async function backfillPreReleaseMeta() {
  const needs = albums.filter(a => a.preRelease && a.spotifyUrl?.includes('/prerelease/'));
  for (const a of needs) {
    const meta = await fetchPreReleaseMeta(a.spotifyUrl);
    if (!meta) continue;
    let changed = false;
    if (!a.artist && meta.artist) { a.artist = meta.artist; changed = true; }
    if (meta.releaseDate && a.releaseDate !== meta.releaseDate) {
      a.releaseDate = meta.releaseDate;
      a.year = meta.releaseDate.slice(0, 4);
      changed = true;
    }
    if (changed) { save(); render(); }
  }
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $shelf         = document.getElementById('shelf');
const $empty         = document.getElementById('emptyState');
const $vinylList     = document.getElementById('vinylList');
const $vinylEmpty    = document.getElementById('vinylEmpty');
const $archiveGrid   = document.getElementById('archiveGrid');
const $archiveEmpty  = document.getElementById('archiveEmpty');
const $modal         = document.getElementById('modal');
const $overlay       = document.getElementById('overlay');
const $addBtn        = document.getElementById('addBtn');
const $closeBtn      = document.getElementById('closeModal');
const $form          = document.getElementById('albumForm');
const $spotifyInput  = document.getElementById('spotifyInput');
const $fetchLoading  = document.getElementById('fetchLoading');
const $fetchError    = document.getElementById('fetchError');
const $albumPreview  = document.getElementById('albumPreview');
const $previewArt    = document.getElementById('previewArt');
const $previewTitle  = document.getElementById('previewTitle');
const $previewArtist = document.getElementById('previewArtist');
const $artistField        = document.getElementById('artistField');
const $artistInput        = document.getElementById('artistInput');
const $releaseDateField   = document.getElementById('releaseDateField');
const $releaseDateInput   = document.getElementById('releaseDateInput');
const $submitBtn     = document.getElementById('submitBtn');
const $settingArchive   = document.getElementById('settingArchive');
const $settingShelfSize = document.getElementById('settingShelfSize');
const $shelfSizeVal     = document.getElementById('shelfSizeVal');
const $settingShopUrl   = document.getElementById('settingShopUrl');
const $preReleaseGrid  = document.getElementById('preReleaseGrid');
const $preReleaseEmpty = document.getElementById('preReleaseEmpty');
const $contextMenu   = document.getElementById('contextMenu');
const $ctxArtImg     = document.getElementById('contextArtImg');
const $ctxNoArt      = document.getElementById('contextNoArt');
const $ctxTitle      = document.getElementById('contextTitle');
const $ctxArtist     = document.getElementById('contextArtist');
const $ctxWiki       = document.getElementById('ctxWiki');
const $ctxBuy        = document.getElementById('ctxBuy');
const $ctxVinyl      = document.getElementById('ctxVinyl');
const $ctxVinylLbl   = document.getElementById('ctxVinylLabel');
const $ctxMoveToShelf = document.getElementById('ctxMoveToShelf');
const $ctxArchive    = document.getElementById('ctxArchive');
const $ctxRemove     = document.getElementById('ctxRemove');
const $ctxRestore    = document.getElementById('ctxRestore');
const $ctxDelete     = document.getElementById('ctxDelete');
const $ctxRemoveLbl  = document.getElementById('ctxRemoveLabel');

// ─── Boot ─────────────────────────────────────────────────────────────────────
(function init() {
  loadSettings();

  try {
    const legacy = localStorage.getItem('shelflife');
    if (legacy !== null) {
      localStorage.setItem('lpq', legacy);
      localStorage.removeItem('shelflife');
    }
    albums = JSON.parse(localStorage.getItem('lpq') || '[]');
  } catch { albums = []; }

  // One-time migration: every existing label was sourced from Spotify, which
  // always returns null — reset to null so MusicBrainz gets a first real attempt.
  // Guarded so it only runs once; otherwise it would wipe freshly-fetched
  // MusicBrainz labels on every subsequent app load.
  if (!localStorage.getItem('lpq-mb-migrated')) {
    for (const a of albums) a.label = null;
    save();
    localStorage.setItem('lpq-mb-migrated', '1');
  }

  // Auto-heal a stale rate-limit window left over from earlier testing/usage —
  // real Spotify 429s are short-lived; anything still blocking >30 min later
  // is almost certainly stuck state, so clear it rather than silently stalling.
  const rl = getRateLimit();
  if (rl && rl - Date.now() > 30 * 60 * 1000) {
    console.warn('[LPQ] Clearing stale rate-limit window (was blocking for', Math.ceil((rl - Date.now()) / 60000), 'more minutes)');
    localStorage.removeItem('lpq-rl');
  }

  checkPreReleases();
  render();
  bindEvents();
  applySettingsUI();
  backfillYears();
  backfillLabels();
  backfillPreReleaseMeta().then(() => { checkPreReleases(); render(); }); // fresh date may trigger promotion

  // Restore the last active tab so a refresh doesn't bounce the user to shelf
  const savedView = sessionStorage.getItem('lpq-view');
  const validViews = ['shelf', 'prerelease', 'vinyl', 'archive', 'settings'];
  if (savedView && validViews.includes(savedView)) switchView(savedView);

  // SW registration and update logic lives in the inline script in index.html
  // so it always runs from the network-fresh HTML regardless of cached app.js.
})();

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  let $t = document.getElementById('toast');
  if (!$t) {
    $t = document.createElement('div');
    $t.id = 'toast';
    $t.className = 'toast toast--hidden';
    document.body.appendChild($t);
  }
  $t.textContent = msg;
  clearTimeout(toastTimer);
  $t.classList.remove('toast--hidden');
  toastTimer = setTimeout(() => $t.classList.add('toast--hidden'), 3000);
}

// ─── Storage ──────────────────────────────────────────────────────────────────
function save() {
  try { localStorage.setItem('lpq', JSON.stringify(albums)); }
  catch (e) {
    console.warn('Storage full:', e);
    alert('Storage is getting full. Try using image URLs instead of uploading files to save space.');
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  renderShelf();
  renderVinyl();
  renderArchive();
  renderPreRelease();
}

function renderShelf() {
  const active = albums.filter(a => !a.archived && !a.preRelease && !a.detached);
  // Ghosts: releases that hit their date on a full shelf — archived, but shown
  // here as inert placeholders for 7 days so the release doesn't slip by unseen.
  const ghosts = albums.filter(a => a.archived && a.ghostUntil && Date.now() < a.ghostUntil);
  $shelf.innerHTML = '';
  $empty.style.display = (active.length || ghosts.length) ? 'none' : 'flex';

  const buildCard = (a, ghost) => {
    const card = document.createElement('div');
    card.className = 'album-card' + (ghost ? ' album-card--ghost' : '');
    card.dataset.id = a.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', ghost
      ? `${a.title} by ${a.artist} — released but shelf was full, now in archive`
      : `${a.title} by ${a.artist}${a.spotifyUrl ? ' — opens Spotify' : ''}`);

    if (a.art) {
      const img = document.createElement('img');
      img.className = 'album-art';
      img.src = a.art;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      card.appendChild(img);
    } else {
      const noArt = document.createElement('div');
      noArt.className = 'album-no-art';
      noArt.textContent = '♪';
      card.appendChild(noArt);
    }

    if (ghost) {
      const badge = document.createElement('div');
      badge.className = 'ghost-badge';
      badge.textContent = 'Shelf Full';
      card.appendChild(badge);
    }

    $shelf.appendChild(card);
  };

  for (const a of active) buildCard(a, false);
  for (const a of ghosts) buildCard(a, true);
}

// Vinyl wishlist: large square artwork on the left, artist/title/year beside.
// Buy and Remove live in the long-press menu (same pattern as the shelf).
function renderVinyl() {
  const vinyl = albums.filter(a => a.vinyl);
  $vinylList.innerHTML = '';
  $vinylEmpty.style.display = vinyl.length ? 'none' : 'flex';

  for (const a of vinyl) {
    const row = document.createElement('div');
    row.className = 'vinyl-row';
    row.dataset.id = a.id;
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${a.title} by ${a.artist}`);

    const art = document.createElement('div');
    art.className = 'vinyl-art';
    if (a.art) {
      const img = document.createElement('img');
      img.src = a.art;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      art.appendChild(img);
    } else {
      art.classList.add('vinyl-art--empty');
      art.textContent = '♪';
    }

    const meta = document.createElement('div');
    meta.className = 'vinyl-meta';
    meta.innerHTML =
      `<div class="vinyl-title">${esc(a.title)}</div>` +
      `<div class="vinyl-artist">${esc(a.artist)}</div>` +
      (a.year ? `<div class="vinyl-year">${esc(a.year)}</div>` : '');

    row.append(art, meta);
    $vinylList.appendChild(row);
  }
}

// Dense crate-digging mosaic: artwork only, desaturated via CSS.
// Artist/title and Restore/Delete actions live in the long-press menu.
function renderArchive() {
  const archived = albums.filter(a => a.archived);
  $archiveGrid.innerHTML = '';
  $archiveEmpty.style.display = archived.length ? 'none' : 'flex';

  for (const a of archived) {
    const cell = document.createElement('div');
    cell.className = 'archive-cell';
    cell.dataset.id = a.id;
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('aria-label', `${a.title} by ${a.artist}, archived`);

    if (a.art) {
      const img = document.createElement('img');
      img.className = 'album-art';
      img.src = a.art;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      cell.appendChild(img);
    } else {
      const noArt = document.createElement('div');
      noArt.className = 'album-no-art';
      noArt.textContent = '♪';
      cell.appendChild(noArt);
    }

    $archiveGrid.appendChild(cell);
  }
}

function renderPreRelease() {
  const upcoming = albums.filter(a => a.preRelease && !a.archived);
  $preReleaseGrid.innerHTML = '';
  $preReleaseEmpty.style.display = upcoming.length ? 'none' : 'flex';

  for (const a of upcoming) {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.dataset.id = a.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `${a.title} by ${a.artist}, releasing ${a.releaseDate ?? 'soon'}`);

    if (a.art) {
      const img = document.createElement('img');
      img.className = 'album-art';
      img.src = a.art;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      card.appendChild(img);
    } else {
      const noArt = document.createElement('div');
      noArt.className = 'album-no-art';
      noArt.textContent = '♪';
      card.appendChild(noArt);
    }

    const badge = document.createElement('div');
    badge.className = 'album-card__date';
    badge.textContent = a.releaseDate ? formatReleaseDate(a.releaseDate) : 'Coming soon';
    card.appendChild(badge);

    $preReleaseGrid.appendChild(card);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ─── Mutations ────────────────────────────────────────────────────────────────
function toggleVinyl(id) {
  const a = albums.find(a => a.id === id);
  if (!a) return;
  a.vinyl = !a.vinyl;
  // Detached albums exist only for the vinyl list — clean them up when removed
  if (!a.vinyl && a.detached) albums = albums.filter(x => x.id !== id);
  save();
}

function archiveAlbum(id) {
  const a = albums.find(a => a.id === id);
  if (!a) return;
  a.archived = true;
  save();
  render();
}

function restoreAlbum(id) {
  const active = albums.filter(a => !a.archived && !a.preRelease && !a.detached);
  if (active.length >= settings.shelfSize) {
    showToast('Your shelf is full — remove an album to make room.');
    return;
  }
  const a = albums.find(a => a.id === id);
  if (!a) return;
  a.archived = false;
  delete a.ghostUntil; // it's a real shelf card now — no placeholder needed
  save();
  render();
}

function deleteAlbum(id) {
  albums = albums.filter(a => a.id !== id);
  save();
  render();
}

// Delete from archive — if the album is in the vinyl wishlist, keep it there
// as a detached entry rather than removing it entirely.
function deleteFromArchive(id) {
  const a = albums.find(a => a.id === id);
  if (!a) return;
  if (a.vinyl) {
    a.archived = false;
    a.detached = true; // vinyl-only: hidden from shelf/archive, visible in vinyl
    delete a.ghostUntil;
  } else {
    albums = albums.filter(x => x.id !== id);
  }
  save();
  render();
}

// ─── View switching ───────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  sessionStorage.setItem('lpq-view', view);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  document.querySelectorAll('.view').forEach(el => {
    el.classList.toggle('view--hidden', el.id !== `view${cap(view)}`);
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('tab-btn--active', btn.dataset.view === view);
  });
  $addBtn.style.display = (view === 'shelf' || view === 'prerelease' || view === 'vinyl') ? '' : 'none';
}

// ─── Context menu ─────────────────────────────────────────────────────────────

// Build the artist · year · label subtitle string
function buildCtxSub(a) {
  let s = a.artist || '';
  if (a.preRelease && a.releaseDate) {
    s += (s ? ' · ' : '') + `Out ${formatReleaseDate(a.releaseDate)}`;
  } else if (a.year) {
    s += (s ? ' · ' : '') + a.year;
  }
  if (a.label) s += (s ? ' · ' : '') + a.label;
  return s;
}

// Rate-limit guard — persisted in localStorage so page refreshes respect it too.
function getRateLimit()       { return parseInt(localStorage.getItem('lpq-rl') || '0', 10); }
function setRateLimit(until)  { localStorage.setItem('lpq-rl', String(until)); }
function isRateLimited() {
  const until = getRateLimit();
  const limited = Date.now() < until;
  if (limited) console.warn('[LPQ] Spotify rate-limited for another', Math.ceil((until - Date.now()) / 1000), 'seconds — year/date fetches are paused.');
  return limited;
}

// Fetch and cache the label for an album that's missing it, then update
// the context menu subtitle live if it's still open for the same album.
// Source: MusicBrainz, not Spotify — Spotify's catalog API returns label:null
// for every album regardless of how well-documented it is.
// null = not yet fetched;  '' = fetched, no MusicBrainz match found.
async function fetchLabelForAlbum(a) {
  const showStatus = (msg) => {
    if (pendingContextId === a.id) $ctxArtist.textContent = buildCtxSub(a) + (buildCtxSub(a) ? ' · ' : '') + msg;
  };
  showStatus('fetching label…');
  a.label = await fetchLabelFromMusicBrainz(a.artist, a.title);
  save();
  if (pendingContextId === a.id) $ctxArtist.textContent = buildCtxSub(a);
}

function openContextMenu(id) {
  const a = albums.find(a => a.id === id);
  if (!a) return;
  pendingContextId = id;

  if (a.art) {
    $ctxArtImg.src    = a.art;
    $ctxArtImg.hidden = false;
    $ctxNoArt.hidden  = true;
  } else {
    $ctxArtImg.hidden = true;
    $ctxNoArt.hidden  = false;
  }
  $ctxTitle.textContent = a.title;
  $ctxArtist.textContent = buildCtxSub(a);
  $ctxVinylLbl.textContent = a.vinyl ? 'Remove from Vinyl' : 'Buy on Vinyl';
  $ctxVinyl.classList.toggle('context-btn--active', !!a.vinyl);
  $ctxMoveToShelf.classList.toggle('visible', currentView === 'prerelease');
  $ctxRemoveLbl.textContent = a.preRelease ? 'Remove' : 'Remove from Shelf';

  // Each view exposes its own set of actions in the long-press menu.
  const inArchive = currentView === 'archive';
  const inVinyl   = currentView === 'vinyl';
  $ctxBuy.classList.toggle('context-btn--hidden', !inVinyl);                // Buy: vinyl only
  $ctxVinyl.classList.toggle('context-btn--hidden', inArchive);            // in vinyl reads "Remove from Vinyl"
  $ctxArchive.classList.toggle('context-btn--hidden', inArchive || inVinyl);
  $ctxRemove.classList.toggle('context-btn--hidden', inArchive || inVinyl);
  $ctxRestore.classList.toggle('context-btn--hidden', !inArchive);
  $ctxDelete.classList.toggle('context-btn--hidden', !inArchive);

  // Fetch label on-demand if not yet confirmed (null = untried; '' = no MusicBrainz match)
  if (a.label == null && a.artist && a.title) {
    fetchLabelForAlbum(a);
  }

  $contextMenu.hidden = false;
  $overlay.classList.add('visible');
  requestAnimationFrame(() => requestAnimationFrame(() => $contextMenu.classList.add('open')));
}

function closeContextMenu() {
  pendingContextId = null;
  $contextMenu.classList.remove('open');
  $overlay.classList.remove('visible');
  setTimeout(() => { $contextMenu.hidden = true; }, 300);
}

// ─── Long press ───────────────────────────────────────────────────────────────
let lpTimer = null;
let lpFired = false;
let lpStart = null;
let lpCard  = null;

function cancelLp() {
  clearTimeout(lpTimer);
  lpCard?.classList.remove('album-card--pressing');
  lpStart = null;
  lpCard  = null;
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
function bindEvents() {
  // ── Nav ───────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // ── Long press on shelf ───────────────────────────────────────────────────
  $shelf.addEventListener('pointerdown', e => {
    const card = e.target.closest('.album-card');
    if (!card || card.classList.contains('album-card--ghost')) return; // ghosts are inert
    lpFired = false;
    lpCard  = card;
    lpStart = { x: e.clientX, y: e.clientY };
    card.classList.add('album-card--pressing');
    lpTimer = setTimeout(() => {
      lpFired = true;
      card.classList.remove('album-card--pressing');
      navigator.vibrate?.(12);
      openContextMenu(card.dataset.id);
    }, 450);
  });

  $shelf.addEventListener('pointermove', e => {
    if (!lpStart) return;
    if (Math.abs(e.clientX - lpStart.x) > 8 || Math.abs(e.clientY - lpStart.y) > 8) cancelLp();
  });

  $shelf.addEventListener('pointerup',     cancelLp);
  $shelf.addEventListener('pointercancel', cancelLp);
  $shelf.addEventListener('contextmenu',   e => e.preventDefault());

  $shelf.addEventListener('click', e => {
    if (lpFired) { lpFired = false; return; }
    const card = e.target.closest('.album-card');
    if (!card || card.classList.contains('album-card--ghost')) return; // no Spotify tap on ghosts
    const a = albums.find(a => a.id === card.dataset.id);
    if (a?.spotifyUrl) window.location.href = toSpotifyUri(a.spotifyUrl);
  });

  // ── Long press on pre-release grid (mirrors shelf) ───────────────────────
  $preReleaseGrid.addEventListener('pointerdown', e => {
    const card = e.target.closest('.album-card');
    if (!card) return;
    lpFired = false;
    lpCard  = card;
    lpStart = { x: e.clientX, y: e.clientY };
    card.classList.add('album-card--pressing');
    lpTimer = setTimeout(() => {
      lpFired = true;
      card.classList.remove('album-card--pressing');
      navigator.vibrate?.(12);
      openContextMenu(card.dataset.id);
    }, 450);
  });

  $preReleaseGrid.addEventListener('pointermove', e => {
    if (!lpStart) return;
    if (Math.abs(e.clientX - lpStart.x) > 8 || Math.abs(e.clientY - lpStart.y) > 8) cancelLp();
  });

  $preReleaseGrid.addEventListener('pointerup',     cancelLp);
  $preReleaseGrid.addEventListener('pointercancel', cancelLp);
  $preReleaseGrid.addEventListener('contextmenu',   e => e.preventDefault());

  $preReleaseGrid.addEventListener('click', e => {
    if (lpFired) { lpFired = false; return; }
    const card = e.target.closest('.album-card');
    if (!card) return;
    const a = albums.find(a => a.id === card.dataset.id);
    if (a?.spotifyUrl) window.location.href = toSpotifyUri(a.spotifyUrl);
  });

  // ── Long press on archive mosaic (no tap action — menu only) ─────────────
  $archiveGrid.addEventListener('pointerdown', e => {
    const cell = e.target.closest('.archive-cell');
    if (!cell) return;
    lpFired = false;
    lpCard  = cell;
    lpStart = { x: e.clientX, y: e.clientY };
    cell.classList.add('album-card--pressing');
    lpTimer = setTimeout(() => {
      lpFired = true;
      cell.classList.remove('album-card--pressing');
      navigator.vibrate?.(12);
      openContextMenu(cell.dataset.id);
    }, 450);
  });

  $archiveGrid.addEventListener('pointermove', e => {
    if (!lpStart) return;
    if (Math.abs(e.clientX - lpStart.x) > 8 || Math.abs(e.clientY - lpStart.y) > 8) cancelLp();
  });

  $archiveGrid.addEventListener('pointerup',     cancelLp);
  $archiveGrid.addEventListener('pointercancel', cancelLp);
  $archiveGrid.addEventListener('contextmenu',   e => e.preventDefault());

  // ── Long press on vinyl rows (mirrors shelf) ─────────────────────────────
  $vinylList.addEventListener('pointerdown', e => {
    const row = e.target.closest('.vinyl-row');
    if (!row) return;
    lpFired = false;
    lpCard  = row;
    lpStart = { x: e.clientX, y: e.clientY };
    row.classList.add('album-card--pressing');
    lpTimer = setTimeout(() => {
      lpFired = true;
      row.classList.remove('album-card--pressing');
      navigator.vibrate?.(12);
      openContextMenu(row.dataset.id);
    }, 450);
  });

  $vinylList.addEventListener('pointermove', e => {
    if (!lpStart) return;
    if (Math.abs(e.clientX - lpStart.x) > 8 || Math.abs(e.clientY - lpStart.y) > 8) cancelLp();
  });

  $vinylList.addEventListener('pointerup',     cancelLp);
  $vinylList.addEventListener('pointercancel', cancelLp);
  $vinylList.addEventListener('contextmenu',   e => e.preventDefault());

  $vinylList.addEventListener('click', e => {
    if (lpFired) { lpFired = false; return; }
    const row = e.target.closest('.vinyl-row');
    if (!row) return;
    const a = albums.find(a => a.id === row.dataset.id);
    if (a?.spotifyUrl) window.location.href = toSpotifyUri(a.spotifyUrl);
  });

  // ── Context menu actions ──────────────────────────────────────────────────
  $ctxMoveToShelf.addEventListener('click', () => {
    const id = pendingContextId;
    if (!id) return;
    const a = albums.find(a => a.id === id);
    if (!a) return;
    // No shelf-size check — this reclassifies an existing album, not a new add
    a.preRelease = false;
    save();
    render();
    showToast('Moved to shelf');
    closeContextMenu();
  });

  $ctxWiki.addEventListener('click', async () => {
    const id = pendingContextId;
    if (!id) return;
    const a = albums.find(a => a.id === id);
    if (!a) return;
    // Open the tab synchronously (within the user gesture) so the async
    // Wikipedia lookup that follows doesn't trip popup blockers.
    const win = window.open('about:blank', '_blank');
    closeContextMenu();
    try {
      const url = await findWikipediaUrl(a);
      if (url) {
        if (win) win.location.href = url;
        else window.location.href = url; // popup blocked — fall back to same tab
      } else {
        win?.close();
        showToast('No Wikipedia article found');
      }
    } catch {
      win?.close();
      showToast('Couldn\'t reach Wikipedia');
    }
  });

  $ctxBuy.addEventListener('click', () => {
    const id = pendingContextId;
    if (!id) return;
    const a = albums.find(a => a.id === id);
    if (!a) return;
    const base = settings.shopUrl || SETTINGS_DEFAULTS.shopUrl;
    window.open(base + encodeURIComponent(a.artist + ' ' + a.title), '_blank');
    closeContextMenu();
  });

  $ctxVinyl.addEventListener('click', () => {
    const id = pendingContextId;
    if (!id) return;
    toggleVinyl(id);
    const a = albums.find(a => a.id === id);
    showToast(a?.vinyl ? 'Added to vinyl wishlist' : 'Removed from vinyl wishlist');
    renderVinyl();
    closeContextMenu();
  });

  $ctxArchive.addEventListener('click', () => {
    const id = pendingContextId;
    if (!id) return;
    closeContextMenu();
    setTimeout(() => { archiveAlbum(id); showToast('Archived'); }, 180);
  });

  $ctxRemove.addEventListener('click', () => {
    const id = pendingContextId;
    if (!id) return;
    closeContextMenu();
    setTimeout(() => {
      if (settings.archiveOnRemove) {
        archiveAlbum(id);
        showToast('Moved to archive');
      } else {
        deleteAlbum(id);
        showToast('Removed from shelf');
      }
    }, 180);
  });

  // Archive-view actions
  $ctxRestore.addEventListener('click', () => {
    const id = pendingContextId;
    if (!id) return;
    closeContextMenu();
    setTimeout(() => restoreAlbum(id), 180); // shows its own toast if the shelf is full
  });

  $ctxDelete.addEventListener('click', () => {
    const id = pendingContextId;
    if (!id) return;
    closeContextMenu();
    setTimeout(() => { deleteFromArchive(id); showToast('Deleted'); }, 180);
  });

  // ── Overlay closes whatever is open ──────────────────────────────────────
  $overlay.addEventListener('click', () => {
    if (!$modal.hidden)            closeModal();
    else if (!$contextMenu.hidden) closeContextMenu();
  });

  // ── Modal open / close ────────────────────────────────────────────────────
  $addBtn.addEventListener('click', () => {
    // Vinyl and pre-release tabs don't occupy shelf slots — always allow.
    if (currentView === 'shelf') {
      if (albums.filter(a => !a.archived && !a.preRelease && !a.detached).length >= settings.shelfSize) {
        showToast(settings.shelfSize < 20
          ? 'Shelf full — raise the limit in Settings or remove an album'
          : 'Shelf full — remove an album to make room');
        return;
      }
    }
    openModal();
  });
  $closeBtn.addEventListener('click', closeModal);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$modal.hidden)            closeModal();
    else if (!$contextMenu.hidden) closeContextMenu();
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  $settingArchive.addEventListener('change', () => {
    settings.archiveOnRemove = $settingArchive.checked;
    saveSettings();
  });

  $settingShelfSize.addEventListener('input', () => {
    settings.shelfSize = parseInt($settingShelfSize.value, 10);
    $shelfSizeVal.textContent = settings.shelfSize;
    saveSettings();
  });

  let shopUrlTimer;
  $settingShopUrl.addEventListener('input', () => {
    clearTimeout(shopUrlTimer);
    shopUrlTimer = setTimeout(() => {
      settings.shopUrl = $settingShopUrl.value.trim() || SETTINGS_DEFAULTS.shopUrl;
      saveSettings();
    }, 600);
  });

  // ── Spotify URL input ─────────────────────────────────────────────────────
  let lookupTimer;
  $spotifyInput.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    const seq = ++lookupSeq; // invalidates any lookup still in flight
    fetchedAlbum = null;
    $submitBtn.disabled = true;
    $albumPreview.hidden = true;
    $previewArt.removeAttribute('src'); // don't let the previous album's art flash
    $artistInput.value      = '';       // …nor its artist/date linger in the manual fields
    $releaseDateInput.value = '';
    $fetchError.hidden = true;
    $fetchLoading.hidden = true;

    const rawUrl  = $spotifyInput.value.trim();
    const albumId = extractAlbumId(rawUrl);
    if (!albumId) return;

    $fetchLoading.hidden = false;
    lookupTimer = setTimeout(async () => {
      try {
        const data = await fetchSpotifyAlbum(albumId, rawUrl);
        if (seq !== lookupSeq) return; // stale — user typed a new URL or closed the modal
        fetchedAlbum = {
          title:       data.title,
          artist:      data.artist,
          art:         data.art,
          spotifyUrl:  data.spotifyUrl,
          year:        data.year,
          releaseDate: data.releaseDate ?? null,
          label:       data.label ?? null,
        };
        if (fetchedAlbum.art) $previewArt.src = fetchedAlbum.art;
        else $previewArt.removeAttribute('src');
        $previewArt.hidden = !fetchedAlbum.art;
        $previewTitle.textContent  = fetchedAlbum.title;
        const isVinyl = currentView === 'vinyl';
        // If opened from the Pre-Releases tab, always treat as pre-release —
        // oEmbed albums without a /prerelease/ URL or release date won't auto-detect.
        const isPre = !isVinyl && (isPreRelease(fetchedAlbum.releaseDate, fetchedAlbum.spotifyUrl) || currentView === 'prerelease');
        const hasMeta = isPre && fetchedAlbum.releaseDate;
        $previewArtist.textContent = (fetchedAlbum.artist || '') +
          (hasMeta ? `${fetchedAlbum.artist ? ' · ' : ''}Out ${formatReleaseDate(fetchedAlbum.releaseDate)}`
                   : (fetchedAlbum.year ? `${fetchedAlbum.artist ? ' · ' : ''}${fetchedAlbum.year}` : ''));
        // Manual artist field only needed for pre-releases (oEmbed omits artist name).
        // Use style.display so it beats any CSS class rule (e.g. .field-group { display:flex }).
        const showArtist = currentView === 'prerelease';
        $artistField.classList.toggle('visible', showArtist);
        $releaseDateField.classList.toggle('visible', showArtist);
        if (showArtist) {
          // Pre-fill whatever we got from oEmbed; blank if nothing
          $artistInput.value      = fetchedAlbum.artist || '';
          $releaseDateInput.value = fetchedAlbum.releaseDate || '';
        }
        // If this was a /prerelease/ URL that couldn't be resolved to catalog data,
        // show a clear notice so the user knows to fill in the missing fields
        if (data.partialLookup && rawUrl.includes('/prerelease/')) {
          $fetchError.textContent = 'Pre-release link — title and artwork fetched. Please fill in the artist and release date below.';
          $fetchError.classList.add('fetch-error--info');
          $fetchError.hidden = false;
        } else {
          $fetchError.classList.remove('fetch-error--info');
          $fetchError.hidden = true;
        }
        $fetchLoading.hidden  = true;
        $albumPreview.hidden  = false;
        $submitBtn.disabled   = false;
        $submitBtn.textContent = isVinyl ? 'Add to Vinyl' : isPre ? 'Add to Pre-Releases' : 'Add to Shelf';
      } catch {
        if (seq !== lookupSeq) return; // stale failure — don't flash an error for it
        $fetchLoading.hidden  = true;
        $fetchError.textContent = 'Couldn\'t find that album — check the URL and try again.';
        $fetchError.hidden    = false;
      }
    }, 400);
  });

  // ── Form submit ───────────────────────────────────────────────────────────
  $form.addEventListener('submit', onSubmit);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal() {
  resetForm();                        // clear stale state; hides artist field
  // On pre-releases tab the artist field is always shown (Spotify may omit it for unreleased albums)
  if (currentView === 'prerelease') {
    $artistField.classList.add('visible');
    $releaseDateField.classList.add('visible');
  }
  $modal.hidden = false;
  $overlay.classList.add('visible');
  requestAnimationFrame(() => requestAnimationFrame(() => $modal.classList.add('open')));
  setTimeout(() => $spotifyInput.focus(), 60);
}

function closeModal() {
  $modal.classList.remove('open');
  $overlay.classList.remove('visible');
  setTimeout(() => {
    $modal.hidden = true;
    resetForm();
  }, 340);
}

function resetForm() {
  lookupSeq++; // cancel any lookup still in flight so it can't repopulate the form
  $form.reset();
  fetchedAlbum         = null;
  $albumPreview.hidden = true;
  $previewArt.removeAttribute('src'); // clear old artwork so it can't flash on reopen
  $previewArt.hidden   = true;
  $previewTitle.textContent  = '';
  $previewArtist.textContent = '';
  $fetchError.hidden   = true;
  $fetchError.classList.remove('fetch-error--info');
  $fetchLoading.hidden = true;
  $artistField.classList.remove('visible');
  $artistInput.value = '';
  $releaseDateField.classList.remove('visible');
  $releaseDateInput.value = '';
  $submitBtn.disabled    = true;
  $submitBtn.textContent = 'Add to Shelf';
}

// ─── Submit ───────────────────────────────────────────────────────────────────
function onSubmit(e) {
  e.preventDefault();
  if (!fetchedAlbum) return;

  const isVinyl = currentView === 'vinyl';
  // Mirror the same logic as the URL lookup — opening from Pre-Releases tab forces pre-release.
  const isPre = !isVinyl && (isPreRelease(fetchedAlbum.releaseDate, fetchedAlbum.spotifyUrl) || currentView === 'prerelease');

  // Shelf-full guard only applies to albums going onto the shelf.
  if (!isPre && !isVinyl && albums.filter(a => !a.archived && !a.preRelease && !a.detached).length >= settings.shelfSize) {
    showToast(settings.shelfSize < 20
      ? 'Shelf full — raise the limit in Settings or remove an album'
      : 'Shelf full — remove an album to make room');
    return;
  }
  // Artist / date fields are only shown for pre-releases; shelf/vinyl use whatever the API returned.
  const artist = fetchedAlbum.artist || (currentView === 'prerelease' ? $artistInput.value.trim() : '');
  const manualDate = currentView === 'prerelease' ? $releaseDateInput.value || null : null;
  const releaseDate = fetchedAlbum.releaseDate ?? manualDate;
  const album = {
    id:          uid(),
    title:       fetchedAlbum.title,
    artist:      artist,
    art:         fetchedAlbum.art,
    spotifyUrl:  fetchedAlbum.spotifyUrl,
    year:        fetchedAlbum.year ?? (releaseDate ? releaseDate.slice(0, 4) : null),
    releaseDate: releaseDate,
    label:       fetchedAlbum.label ?? null,
    addedAt:     Date.now(),
    vinyl:       isVinyl,
    detached:    isVinyl,
    archived:    false,
    preRelease:  isPre,
  };

  albums.unshift(album);
  save();
  render();
  closeModal();
}

// ─── Utils ────────────────────────────────────────────────────────────────────

// Convert a Spotify web URL or existing URI to the spotify: URI scheme.
// Prerelease URLs stay as https:// — spotify:album:ID doesn't work for
// unreleased content; the https URL triggers universal links on mobile.
function toSpotifyUri(url) {
  if (!url) return url;
  if (url.startsWith('spotify:')) return url;
  if (url.includes('/prerelease/')) return url; // universal link, handled by Spotify app
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `spotify:${parts[0]}:${parts[1]}`;
  } catch {}
  return url;
}

// Local calendar date as YYYY-MM-DD. All release-date logic must use this,
// never toISOString() — UTC's date can differ from the device's, which made
// pre-releases promote a day early (e.g. a July 17 midnight release in Ireland
// is 2026-07-16T23:00:00Z in UTC).
function localISODate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Returns true if the album should live in the Pre-Releases section.
// Checks release date (if known) OR the Spotify URL path (/prerelease/).
function isPreRelease(releaseDate, spotifyUrl) {
  // A confirmed past/present date means it's been released — beats URL pattern
  if (releaseDate) {
    const parts = releaseDate.split('-');
    const pastYear = parts.length === 1 && parseInt(parts[0]) <= new Date().getFullYear();
    const pastDate = parts.length > 1 && releaseDate <= localISODate();
    if (pastYear || pastDate) return false;
  }
  // No confirmed past date — URL pattern is the next best signal
  if (spotifyUrl && spotifyUrl.includes('/prerelease/')) return true;
  if (!releaseDate) return false;
  return true; // has a date and it's confirmed future (checked above)
}

// Format a Spotify release_date for display (e.g. "15 Jun 2025")
function formatReleaseDate(dateStr) {
  if (!dateStr) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parseInt(parts[2])} ${months[parseInt(parts[1]) - 1]} ${parts[0]}`;
  }
  if (parts.length === 2) {
    return `${months[parseInt(parts[1]) - 1]} ${parts[0]}`;
  }
  return parts[0];
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
