'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let albums = [];
let pendingContextId = null;
let currentView = 'shelf';
let fetchedAlbum = null;

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
    if (!a.preRelease) continue;
    // Never auto-promote if we don't have a date to check against
    if (!a.releaseDate && !a.spotifyUrl?.includes('/prerelease/')) continue;
    if (!isPreRelease(a.releaseDate, a.spotifyUrl)) {
      // Check shelf capacity before marking as released (before it counts toward the shelf)
      const shelfFull = albums.filter(
        x => !x.archived && !x.preRelease && !x.detached
      ).length >= settings.shelfSize;
      a.preRelease = false;
      if (shelfFull) a.archived = true; // no room — go straight to archive
      changed = true;
    }
  }
  if (changed) save();
}

// Silently fetch release years / dates / labels for albums that pre-date those features.
// Pre-release albums are skipped — oEmbed never returns label/year for unreleased content.
// null label = not yet tried;  '' label = tried, Spotify confirmed no label.
// Runs with a 300 ms gap between requests to stay well under Spotify's rate limit.
async function backfillYears() {
  if (isRateLimited()) return; // respect persisted rate-limit window
  const needsData = albums.filter(a =>
    a.spotifyUrl &&
    !a.spotifyUrl.includes('/prerelease/') &&
    (!a.year || !a.releaseDate || a.label == null)
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
      if (a.label == null)                  { a.label = d.label || '';              changed = true; }
    } catch (err) {
      console.warn('[LPQ] backfillYears failed for', a.title, err);
    }
  }
  if (changed) { save(); render(); }
}

function applySettingsUI() {
  $settingArchive.checked    = settings.archiveOnRemove;
  $settingShelfSize.value    = settings.shelfSize;
  $shelfSizeVal.textContent  = settings.shelfSize;
  $settingShopUrl.value      = settings.shopUrl;
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
    title:       d.title,
    artist:      d.author_name || '',
    art:         d.thumbnail_url ?? null,
    spotifyUrl:  rawUrl.split('?')[0],
    year:        null,
    releaseDate: null,
    label:       null,
  };
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $shelf         = document.getElementById('shelf');
const $empty         = document.getElementById('emptyState');
const $vinylList     = document.getElementById('vinylList');
const $vinylEmpty    = document.getElementById('vinylEmpty');
const $archiveList   = document.getElementById('archiveList');
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
const $ctxVinyl      = document.getElementById('ctxVinyl');
const $ctxVinylLbl   = document.getElementById('ctxVinylLabel');
const $ctxMoveToShelf = document.getElementById('ctxMoveToShelf');
const $ctxArchive    = document.getElementById('ctxArchive');
const $ctxRemove     = document.getElementById('ctxRemove');
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

  // Migration: reset '' labels (incorrectly set by oEmbed fallback or rate-limited
  // fetches) so they're re-fetched from the catalog API this session.
  let migrated = false;
  for (const a of albums) {
    if (a.label === '') { a.label = null; migrated = true; }
  }
  if (migrated) save();

  checkPreReleases();
  render();
  bindEvents();
  applySettingsUI();
  backfillYears();

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
  $shelf.innerHTML = '';
  $empty.style.display = active.length ? 'none' : 'flex';

  for (const a of active) {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.dataset.id = a.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `${a.title} by ${a.artist}${a.spotifyUrl ? ' — opens Spotify' : ''}`);

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

    $shelf.appendChild(card);
  }
}

function renderVinyl() {
  const vinyl = albums.filter(a => a.vinyl);
  $vinylList.innerHTML = '';
  $vinylEmpty.style.display = vinyl.length ? 'none' : 'flex';

  for (const a of vinyl) {
    $vinylList.appendChild(makeListRow(a, [
      {
        label: 'Buy',
        action() {
          const base = settings.shopUrl || SETTINGS_DEFAULTS.shopUrl;
          window.open(base + encodeURIComponent(a.artist + ' ' + a.title), '_blank');
        },
      },
      { label: 'Remove', action() { toggleVinyl(a.id); renderVinyl(); } },
    ]));
  }
}

function renderArchive() {
  const archived = albums.filter(a => a.archived);
  $archiveList.innerHTML = '';
  $archiveEmpty.style.display = archived.length ? 'none' : 'flex';

  for (const a of archived) {
    const row = makeListRow(a, [
      { label: 'Restore', action() { restoreAlbum(a.id); } },
      { label: 'Delete',  danger: true, action() { deleteFromArchive(a.id); } },
    ]);
    // No Spotify tap on archived thumbnails — use the shelf for that
    $archiveList.appendChild(row);
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

function makeListRow(a, actions) {
  const row = document.createElement('div');
  row.className = 'list-row';

  const thumb = document.createElement('div');
  thumb.className = 'list-thumb';
  if (a.art) {
    const img = document.createElement('img');
    img.src = a.art;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);
  } else {
    thumb.classList.add('list-thumb--empty');
    thumb.textContent = '♪';
  }

  const meta = document.createElement('div');
  meta.className = 'list-meta';
  const sub = a.artist + (a.year ? ` · ${a.year}` : '');
  meta.innerHTML =
    `<div class="list-title">${esc(a.title)}</div>` +
    `<div class="list-artist">${esc(sub)}</div>`;

  const actionsEl = document.createElement('div');
  actionsEl.className = 'list-actions';
  for (const { label, danger, action } of actions) {
    const btn = document.createElement('button');
    btn.className = 'list-btn' + (danger ? ' list-btn--danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', action);
    actionsEl.appendChild(btn);
  }

  row.append(thumb, meta, actionsEl);
  return row;
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
  } else {
    albums = albums.filter(x => x.id !== id);
  }
  save();
  render();
}

// ─── View switching ───────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
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
function isRateLimited()      { return Date.now() < getRateLimit(); }

// Fetch and cache the label for an album that's missing it, then update
// the context menu subtitle live if it's still open for the same album.
// null  = not yet fetched;  '' = fetched, Spotify confirmed no label.
async function fetchLabelForAlbum(a) {
  if (isRateLimited()) return;
  try {
    const id = extractAlbumId(a.spotifyUrl);
    if (!id) { a.label = ''; save(); return; }
    const token = await getSpotifyToken();
    const res = await fetch(`https://api.spotify.com/v1/albums/${id}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Honour retry-after header; default to 2 hours if missing
        const retryAfter = parseInt(res.headers.get('retry-after') || '7200', 10);
        setRateLimit(Date.now() + retryAfter * 1000);
      } else if (res.status === 404) {
        a.label = ''; save();
      }
      return;
    }
    const d = await res.json();
    a.label = d.label || ''; // '' = confirmed no label in Spotify
    save();
    if (pendingContextId === a.id) {
      $ctxArtist.textContent = buildCtxSub(a);
    }
  } catch (err) {
    console.warn('[LPQ] fetchLabelForAlbum error:', err);
  }
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

  // Fetch label on-demand if not yet confirmed (null = untried; '' = no label in Spotify)
  if (a.label == null && a.spotifyUrl && !a.spotifyUrl.includes('/prerelease/')) {
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
    if (!card) return;
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
    fetchedAlbum = null;
    $submitBtn.disabled = true;
    $albumPreview.hidden = true;
    $fetchError.hidden = true;
    $fetchLoading.hidden = true;

    const rawUrl  = $spotifyInput.value.trim();
    const albumId = extractAlbumId(rawUrl);
    if (!albumId) return;

    $fetchLoading.hidden = false;
    lookupTimer = setTimeout(async () => {
      try {
        const data = await fetchSpotifyAlbum(albumId, rawUrl);
        fetchedAlbum = {
          title:       data.title,
          artist:      data.artist,
          art:         data.art,
          spotifyUrl:  data.spotifyUrl,
          year:        data.year,
          releaseDate: data.releaseDate ?? null,
          label:       data.label ?? null,
        };
        $previewArt.src            = fetchedAlbum.art || '';
        $previewArt.hidden         = !fetchedAlbum.art;
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
        // Pre-fill date picker if Spotify returned one, otherwise leave blank
        if (showArtist) $releaseDateInput.value = fetchedAlbum.releaseDate || '';
        $artistInput.value   = '';
        $fetchLoading.hidden  = true;
        $albumPreview.hidden  = false;
        $submitBtn.disabled   = false;
        $submitBtn.textContent = isVinyl ? 'Add to Vinyl' : isPre ? 'Add to Pre-Releases' : 'Add to Shelf';
      } catch {
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
  $form.reset();
  fetchedAlbum         = null;
  $albumPreview.hidden = true;
  $fetchError.hidden   = true;
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

// Returns true if the album should live in the Pre-Releases section.
// Checks release date (if known) OR the Spotify URL path (/prerelease/).
function isPreRelease(releaseDate, spotifyUrl) {
  // A confirmed past/present date means it's been released — beats URL pattern
  if (releaseDate) {
    const parts = releaseDate.split('-');
    const pastYear = parts.length === 1 && parseInt(parts[0]) <= new Date().getFullYear();
    const pastDate = parts.length > 1 && releaseDate <= new Date().toISOString().slice(0, 10);
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
