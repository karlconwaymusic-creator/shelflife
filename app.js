'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let albums = [];
let pendingArt = null;
let pendingContextId = null;
let currentView = 'shelf';

const MAX_ALBUMS = 20;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $shelf        = document.getElementById('shelf');
const $empty        = document.getElementById('emptyState');
const $vinylList    = document.getElementById('vinylList');
const $vinylEmpty   = document.getElementById('vinylEmpty');
const $archiveList  = document.getElementById('archiveList');
const $archiveEmpty = document.getElementById('archiveEmpty');
const $modal        = document.getElementById('modal');
const $overlay      = document.getElementById('overlay');
const $addBtn       = document.getElementById('addBtn');
const $closeBtn     = document.getElementById('closeModal');
const $form         = document.getElementById('albumForm');
const $artDrop      = document.getElementById('artDrop');
const $artFile      = document.getElementById('artFile');
const $artImg       = document.getElementById('artImg');
const $artPh        = document.getElementById('artPlaceholder');
const $artUrl       = document.getElementById('artUrl');
const $title        = document.getElementById('albumTitle');
const $artist       = document.getElementById('artistName');
const $spotify      = document.getElementById('spotifyUrl');
const $contextMenu  = document.getElementById('contextMenu');
const $ctxArtImg    = document.getElementById('contextArtImg');
const $ctxNoArt     = document.getElementById('contextNoArt');
const $ctxTitle     = document.getElementById('contextTitle');
const $ctxArtist    = document.getElementById('contextArtist');
const $ctxVinyl     = document.getElementById('ctxVinyl');
const $ctxVinylLbl  = document.getElementById('ctxVinylLabel');
const $ctxArchive   = document.getElementById('ctxArchive');
const $ctxRemove    = document.getElementById('ctxRemove');

// ─── Boot ─────────────────────────────────────────────────────────────────────
(function init() {
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
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
    // LocalStorage quota exceeded — happens when many high-res covers stored as base64.
    // Notify user and still keep in-memory state intact.
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
      { label: 'Remove', action() { toggleVinyl(a.id); renderVinyl(); } }
    ]));
  }
}

function renderArchive() {
  const archived = albums.filter(a => a.archived);
  $archiveList.innerHTML = '';
  $archiveEmpty.style.display = archived.length ? 'none' : 'flex';

  for (const a of archived) {
    $archiveList.appendChild(makeListRow(a, [
      { label: 'Restore', action() { restoreAlbum(a.id); } },
      { label: 'Delete',  danger: true, action() { deleteAlbum(a.id); } },
    ]));
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
  meta.innerHTML =
    `<div class="list-title">${esc(a.title)}</div>` +
    `<div class="list-artist">${esc(a.artist)}</div>`;

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

// Minimal HTML escape — only used for inserting user strings into innerHTML
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
  if (active.length >= MAX_ALBUMS) {
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
  $ctxTitle.textContent    = a.title;
  $ctxArtist.textContent   = a.artist;
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

const cancelLp = () => {
  clearTimeout(lpTimer);
  lpCard?.classList.remove('album-card--pressing');
  lpStart = null;
  lpCard  = null;
};

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
    setTimeout(() => { deleteAlbum(id); showToast('Removed from shelf'); }, 180);
  });

  // ── Overlay closes whatever is open ──────────────────────────────────────
  $overlay.addEventListener('click', () => {
    if (!$modal.hidden)       closeModal();
    else if (!$contextMenu.hidden) closeContextMenu();
  });

  // ── Modal open / close ────────────────────────────────────────────────────
  $addBtn.addEventListener('click', () => {
    if (albums.filter(a => !a.archived).length >= MAX_ALBUMS) {
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

  // ── Art drop zone ─────────────────────────────────────────────────────────
  $artDrop.addEventListener('click', () => $artFile.click());
  $artDrop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $artFile.click(); }
  });
  $artFile.addEventListener('change', e => {
    if (e.target.files[0]) processFile(e.target.files[0]);
  });

  $artDrop.addEventListener('dragover', e => {
    e.preventDefault();
    $artDrop.classList.add('drag-over');
  });
  $artDrop.addEventListener('dragleave', e => {
    if (!$artDrop.contains(e.relatedTarget)) $artDrop.classList.remove('drag-over');
  });
  $artDrop.addEventListener('drop', e => {
    e.preventDefault();
    $artDrop.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f?.type.startsWith('image/')) processFile(f);
  });

  // ── Paste image anywhere while modal is open ──────────────────────────────
  document.addEventListener('paste', e => {
    if ($modal.hidden) return;
    for (const item of (e.clipboardData?.items ?? [])) {
      if (item.type.startsWith('image/')) {
        processFile(item.getAsFile());
        return;
      }
    }
  });

  // ── Art URL live preview ──────────────────────────────────────────────────
  let urlTimer;
  $artUrl.addEventListener('input', () => {
    clearTimeout(urlTimer);
    const url = $artUrl.value.trim();
    if (!url) {
      if (!pendingArt) clearArt();
      return;
    }
    urlTimer = setTimeout(() => {
      if (pendingArt) return;
      const probe = new Image();
      probe.onload  = () => showArt(url);
      probe.onerror = () => {};
      probe.src = url;
    }, 600);
  });

  // ── Form submit ───────────────────────────────────────────────────────────
  $form.addEventListener('submit', onSubmit);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal() {
  $modal.hidden = false;
  $overlay.classList.add('visible');
  requestAnimationFrame(() => requestAnimationFrame(() => $modal.classList.add('open')));
  setTimeout(() => $title.focus(), 60);
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
  pendingArt = null;
  clearArt();
  $title.classList.remove('error');
  $artist.classList.remove('error');
}

// ─── Art handling ─────────────────────────────────────────────────────────────
async function processFile(file) {
  try {
    const dataUrl = await cropAndCompress(file, 400, 0.83);
    pendingArt = { value: dataUrl };
    showArt(dataUrl);
    $artUrl.value = '';
  } catch (err) {
    console.error('Image processing error:', err);
  }
}

function cropAndCompress(file, dim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ({ target: { result } }) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const s   = Math.min(img.width, img.height);
        const sx  = (img.width  - s) / 2;
        const sy  = (img.height - s) / 2;
        const out = Math.min(s, dim);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = out;
        canvas.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, out, out);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  });
}

function showArt(src) {
  $artImg.src = src;
  $artImg.hidden = false;
  $artPh.hidden = true;
  $artDrop.classList.add('has-art');
}

function clearArt() {
  $artImg.src = '';
  $artImg.hidden = true;
  $artPh.hidden = false;
  $artDrop.classList.remove('has-art');
}

// ─── Submit ───────────────────────────────────────────────────────────────────
function onSubmit(e) {
  e.preventDefault();

  const title  = $title.value.trim();
  const artist = $artist.value.trim();

  $title.classList.toggle('error',  !title);
  $artist.classList.toggle('error', !artist);
  if (!title || !artist) return;

  const artUrlVal = $artUrl.value.trim();
  const art = pendingArt?.value ?? (artUrlVal || null);

  const album = {
    id:         uid(),
    title,
    artist,
    art,
    spotifyUrl: $spotify.value.trim() || null,
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
// https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy → spotify:album:4aawyAB9vmqN3uQ7FjRGTy
function toSpotifyUri(url) {
  if (!url) return url;
  if (url.startsWith('spotify:')) return url;
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `spotify:${parts[0]}:${parts[1]}`;
  } catch { /* not a valid URL, fall through */ }
  return url;
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
