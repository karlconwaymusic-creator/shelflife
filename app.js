'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let albums = [];
let deferredInstall = null;
let pendingArt = null; // { value: string } — data URL wins over artUrl field

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_ALBUMS = 20;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $shelf        = document.getElementById('shelf');
const $empty        = document.getElementById('emptyState');
const $modal        = document.getElementById('modal');
const $overlay      = document.getElementById('overlay');
const $addBtn       = document.getElementById('addBtn');
const $shelfFullMsg = document.getElementById('shelfFullMsg');
const $closeBtn     = document.getElementById('closeModal');
const $instBtn  = document.getElementById('installBtn');
const $form     = document.getElementById('albumForm');
const $artDrop  = document.getElementById('artDrop');
const $artFile  = document.getElementById('artFile');
const $artImg   = document.getElementById('artImg');
const $artPh    = document.getElementById('artPlaceholder');
const $artUrl   = document.getElementById('artUrl');
const $title    = document.getElementById('albumTitle');
const $artist   = document.getElementById('artistName');
const $spotify  = document.getElementById('spotifyUrl');

// ─── Boot ─────────────────────────────────────────────────────────────────────
(function init() {
  try { albums = JSON.parse(localStorage.getItem('shelflife') || '[]'); }
  catch { albums = []; }

  render();
  bindEvents();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

// ─── Storage ──────────────────────────────────────────────────────────────────
function save() {
  try { localStorage.setItem('shelflife', JSON.stringify(albums)); }
  catch (e) {
    // LocalStorage quota exceeded — happens when many high-res covers stored as base64.
    // Notify user and still keep in-memory state intact.
    console.warn('Storage full:', e);
    alert('Storage is getting full. Try using image URLs instead of uploading files to save space.');
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  $shelf.innerHTML = '';
  $empty.style.display = albums.length ? 'none' : 'flex';

  const isFull = albums.length >= MAX_ALBUMS;
  $addBtn.disabled = isFull;
  $addBtn.setAttribute('aria-disabled', isFull);
  $shelfFullMsg.hidden = !isFull;

  for (const a of albums) {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.dataset.id = a.id;
    card.setAttribute('role', 'listitem');
    if (a.spotifyUrl) {
      card.setAttribute('aria-label', `${a.title} by ${a.artist} — opens Spotify`);
    } else {
      card.setAttribute('aria-label', `${a.title} by ${a.artist}`);
    }

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

    const info = document.createElement('div');
    info.className = 'album-info';
    info.innerHTML =
      `<div class="album-title">${esc(a.title)}</div>` +
      `<div class="album-artist">${esc(a.artist)}</div>`;
    card.appendChild(info);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'remove-btn';
    rmBtn.dataset.action = 'remove';
    rmBtn.setAttribute('aria-label', `Remove ${esc(a.title)}`);
    rmBtn.innerHTML =
      `<svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor"` +
      ` stroke-width="2.5" stroke-linecap="round">` +
      `<line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>`;
    card.appendChild(rmBtn);

    $shelf.appendChild(card);
  }
}

// Minimal HTML escape — only used for inserting user strings into innerHTML
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
function bindEvents() {
  // ── Shelf (event delegation) ──────────────────────────────────────────────
  $shelf.addEventListener('click', e => {
    const rmBtn = e.target.closest('[data-action="remove"]');
    if (rmBtn) {
      e.stopPropagation();
      const id = rmBtn.closest('.album-card').dataset.id;
      albums = albums.filter(a => a.id !== id);
      save();
      render();
      return;
    }
    const card = e.target.closest('.album-card');
    if (card) {
      const a = albums.find(a => a.id === card.dataset.id);
      if (a?.spotifyUrl) window.location.href = toSpotifyUri(a.spotifyUrl);
    }
  });

  // ── Modal open / close ────────────────────────────────────────────────────
  $addBtn.addEventListener('click', openModal);
  $closeBtn.addEventListener('click', closeModal);
  $overlay.addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ── PWA install prompt ────────────────────────────────────────────────────
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    $instBtn.hidden = false;
  });
  $instBtn.addEventListener('click', () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.then(() => {
      $instBtn.hidden = true;
      deferredInstall = null;
    });
  });
  window.addEventListener('appinstalled', () => { $instBtn.hidden = true; });

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
      if (pendingArt) return; // uploaded file takes priority
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
  // Double rAF lets the browser paint before starting the CSS transition
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
    // Clear URL field so it's obvious the file wins
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
        // Square-crop from the center, then scale to dim×dim
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
    id: uid(),
    title,
    artist,
    art,
    spotifyUrl: $spotify.value.trim() || null,
    addedAt: Date.now(),
  };

  albums.unshift(album);
  save();
  render();
  closeModal();
}

// ─── Utils ────────────────────────────────────────────────────────────────────

// Convert a Spotify web URL or existing URI to the spotify: URI scheme.
// https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy → spotify:album:4aawyAB9vmqN3uQ7FjRGTy
// Already-correct URIs (spotify:album:...) are returned unchanged.
function toSpotifyUri(url) {
  if (!url) return url;
  if (url.startsWith('spotify:')) return url;
  try {
    const { pathname } = new URL(url);        // e.g. /album/4aawyAB9vmqN3uQ7FjRGTy
    const parts = pathname.split('/').filter(Boolean); // ['album', '4aaw...']
    if (parts.length >= 2) return `spotify:${parts[0]}:${parts[1]}`;
  } catch { /* not a valid URL, fall through */ }
  return url;
}

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
