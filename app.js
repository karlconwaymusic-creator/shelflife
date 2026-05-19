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

// Silently fetch release years for albums that pre-date the year feature
async function backfillYears() {
  const needsYear = albums.filter(a => a.spotifyUrl && !a.year);
  if (!needsYear.length) return;
  for (const a of needsYear) {
    try {
      const id = extractAlbumId(a.spotifyUrl);
      if (!id) continue;
      const data = await fetchSpotifyAlbum(id, a.spotifyUrl);
      if (data.year) {
        a.year = data.year;
      }
    } catch {}
  }
  save();
  render();
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
        title:      d.name,
        artist:     d.artists.map(a => a.name).join(', '),
        art:        d.images[0]?.url ?? null,
        spotifyUrl: d.external_urls.spotify,
        year:       d.release_date ? d.release_date.slice(0, 4) : null,
      };
    }
  } catch {}

  // Fall back to oEmbed — works for pre-releases not yet in the catalog
  const oe = await fetch(
    'https://open.spotify.com/oembed?url=' + encodeURIComponent(rawUrl)
  );
  if (!oe.ok) throw new Error('Album not found');
  const d = await oe.json();
  return {
    title:      d.title,
    artist:     d.author_name,
    art:        d.thumbnail_url ?? null,
    spotifyUrl: rawUrl.split('?')[0],
    year:       null,
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
const $submitBtn     = document.getElementById('submitBtn');
const $settingArchive   = document.getElementById('settingArchive');
const $settingShelfSize = document.getElementById('settingShelfSize');
const $shelfSizeVal     = document.getElementById('shelfSizeVal');
const $settingShopUrl   = document.getElementById('settingShopUrl');
const $contextMenu   = document.getElementById('contextMenu');
const $ctxArtImg     = document.getElementById('contextArtImg');
const $ctxNoArt      = document.getElementById('contextNoArt');
const $ctxTitle      = document.getElementById('contextTitle');
const $ctxArtist     = document.getElementById('contextArtist');
const $ctxVinyl      = document.getElementById('ctxVinyl');
const $ctxVinylLbl   = document.getElementById('ctxVinylLabel');
const $ctxArchive    = document.getElementById('ctxArchive');
const $ctxRemove     = document.getElementById('ctxRemove');

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

  render();
  bindEvents();
  applySettingsUI();
  backfillYears();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
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
}

function renderShelf() {
  const active = albums.filter(a => !a.archived);
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
      { label: 'Delete',  danger: true, action() { deleteAlbum(a.id); } },
    ]);
    if (a.spotifyUrl) {
      const thumb = row.querySelector('.list-thumb');
      thumb.classList.add('list-thumb--link');
      thumb.addEventListener('click', () => window.location.href = toSpotifyUri(a.spotifyUrl));
    }
    $archiveList.appendChild(row);
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
  const active = albums.filter(a => !a.archived);
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
  $addBtn.style.display = view === 'shelf' ? '' : 'none';
}

// ─── Context menu ─────────────────────────────────────────────────────────────
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
  $ctxTitle.textContent  = a.title;
  $ctxArtist.textContent = a.artist + (a.year ? ` · ${a.year}` : '');
  $ctxVinylLbl.textContent = a.vinyl ? 'Remove from Vinyl' : 'Buy on Vinyl';
  $ctxVinyl.classList.toggle('context-btn--active', !!a.vinyl);

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

  // ── Context menu actions ──────────────────────────────────────────────────
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
    if (albums.filter(a => !a.archived).length >= settings.shelfSize) {
      showToast('Your shelf is full — remove an album to make room.');
      return;
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
          title:      data.title,
          artist:     data.artist,
          art:        data.art,
          spotifyUrl: data.spotifyUrl,
          year:       data.year,
        };
        $previewArt.src            = fetchedAlbum.art || '';
        $previewArt.hidden         = !fetchedAlbum.art;
        $previewTitle.textContent  = fetchedAlbum.title;
        $previewArtist.textContent = fetchedAlbum.artist;
        $fetchLoading.hidden        = true;
        $albumPreview.hidden        = false;
        $submitBtn.disabled         = false;
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
  $submitBtn.disabled  = true;
}

// ─── Submit ───────────────────────────────────────────────────────────────────
function onSubmit(e) {
  e.preventDefault();
  if (!fetchedAlbum) return;

  const album = {
    id:        uid(),
    title:     fetchedAlbum.title,
    artist:    fetchedAlbum.artist,
    art:        fetchedAlbum.art,
    spotifyUrl: fetchedAlbum.spotifyUrl,
    year:       fetchedAlbum.year ?? null,
    addedAt:    Date.now(),
    vinyl:      false,
    archived:   false,
  };

  albums.unshift(album);
  save();
  render();
  closeModal();
}

// ─── Utils ────────────────────────────────────────────────────────────────────

// Convert a Spotify web URL or existing URI to the spotify: URI scheme.
// Pre-release URLs use /prerelease/ but map to the same album: URI type.
function toSpotifyUri(url) {
  if (!url) return url;
  if (url.startsWith('spotify:')) return url;
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const type = parts[0] === 'prerelease' ? 'album' : parts[0];
      return `spotify:${type}:${parts[1]}`;
    }
  } catch {}
  return url;
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
