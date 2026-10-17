'use strict';
// LPQ's rules: everything here is plain logic with no screen code, so it can be
// tested on its own (tests/logic.test.mjs) and is loaded before app.js.
// Functions that read app state take it as a parameter; a few default to the
// live `settings` object that app.js defines.

const MAX_ALBUMS = 20; // hard ceiling; user limit is settings.shelfSize

const SETTINGS_DEFAULTS = {
  archiveOnRemove: true,
  shelfSize:       12,
  shopUrl:         'https://towerrecords.ie/search?q=',
  archiveView:     'mosaic', // 'mosaic' | 'list'
  preferredFormat: 'Vinyl', // 'Vinyl' | 'CD' — appended verbatim to the Buy search query
};

// Backup (export / import) limits and the rules for what an import may contain.
const BACKUP_VERSION    = 1;
const BACKUP_MAX_BYTES  = 5 * 1024 * 1024;
const BACKUP_MAX_ALBUMS = 2000;
const DAY_MS            = 24 * 60 * 60 * 1000;
const BACKUP_NUDGE_MS        = 30 * DAY_MS; // remind when the last backup is this old...
const BACKUP_FIRST_NUDGE_MS  = 3 * DAY_MS;  // ...or this soon after install if there never was one
const BACKUP_NUDGE_REPEAT_MS = 7 * DAY_MS;  // and then no more than once a week
const SPOTIFY_URL_OK = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:album|prerelease)\/[A-Za-z0-9]+/;

// Promote pre-release albums whose release date has now passed.
// Only acts when we have a confirmed release date — albums with no date stay
// in Pre-Releases until the date is known (backfill) or they're manually moved.
//
// A released album with no room on the shelf does NOT archive immediately.
// It stays in Pre-Releases — fully interactive (Wikipedia, Buy on Vinyl,
// Move to Shelf, Archive, Remove all still work) except the Spotify tap
// shortcut, which is disabled — showing a "Shelf Full" badge instead of the
// release date. a.shelfFullSince marks when this waiting period began. On
// every check: if shelf room has since opened up, it promotes to the shelf
// immediately; if 7 days pass with the shelf still full, it archives for
// good (and stays archived regardless of shelf room after that).
const SHELF_FULL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
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
function isPreRelease(releaseDate, spotifyUrl, today = localISODate()) {
  // A confirmed past/present date means it's been released — beats URL pattern
  if (releaseDate) {
    const parts = releaseDate.split('-');
    const pastYear = parts.length === 1 && parseInt(parts[0]) <= parseInt(today.slice(0, 4));
    const pastDate = parts.length > 1 && releaseDate <= today;
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

function extractAlbumId(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const i = parts.findIndex(p => p === 'album' || p === 'prerelease');
    if (i !== -1 && parts[i + 1]) return parts[i + 1].split('?')[0];
  } catch {}
  return null;
}

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

function normAlbumKey(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function albumLocation(a) {
  if (a.archived) return 'Archive';
  if (a.preRelease) return 'Pre-Releases';
  if (a.vinyl || a.detached) return 'Get Physical';
  return 'Shelf';
}

function albumSection(a) {
  return a.archived ? 'archive' : a.preRelease ? 'prerelease' : (a.vinyl || a.detached) ? 'vinyl' : 'shelf';
}

// Albums and EPs only. Spotify labels EPs "single", so a "single" with 4+
// tracks is kept as an EP; real singles (1-3 tracks) are dropped.
function isAlbumOrEp(item) {
  if (item.album_type === 'album' || item.album_type === 'compilation') return true;
  return item.album_type === 'single' && (item.total_tracks || 0) >= 4;
}

function toSearchResult(item) {
  return {
    id:          item.id,
    title:       item.name,
    artist:      (item.artists || []).map(a => a.name).join(', '),
    thumb:       item.images?.[1]?.url ?? item.images?.[0]?.url ?? null,
    art:         item.images?.[0]?.url ?? null,
    spotifyUrl:  item.external_urls?.spotify ?? `https://open.spotify.com/album/${item.id}`,
    releaseDate: item.release_date ?? null,
    year:        item.release_date ? item.release_date.slice(0, 4) : null,
  };
}

// A backup is just text, so treat it as untrusted: keep only known fields with
// the right types, and only accept genuine Spotify / https addresses — album
// links are opened when tapped, so an arbitrary string must never get in.
function cleanStr(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

function sanitizeAlbum(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanStr(raw.title, 300);
  if (!title) return null;
  const album = {
    id:          cleanStr(raw.id, 80) || uid(),
    title,
    artist:      cleanStr(raw.artist, 300),
    art:         typeof raw.art === 'string' && /^https:\/\//.test(raw.art) && raw.art.length <= 2000 ? raw.art : null,
    spotifyUrl:  typeof raw.spotifyUrl === 'string' && SPOTIFY_URL_OK.test(raw.spotifyUrl) && raw.spotifyUrl.length <= 500 ? raw.spotifyUrl : null,
    year:        /^\d{4}$/.test(String(raw.year ?? '')) ? String(raw.year) : null,
    releaseDate: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(raw.releaseDate ?? '')) ? String(raw.releaseDate) : null,
    label:       typeof raw.label === 'string' ? raw.label.trim().slice(0, 200) : null, // '' = looked up, no match
    addedAt:     Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    vinyl:       raw.vinyl === true,
    detached:    raw.detached === true,
    archived:    raw.archived === true,
    preRelease:  raw.preRelease === true,
  };
  if (Number.isFinite(raw.shelfFullSince)) album.shelfFullSince = raw.shelfFullSince;
  return album;
}

function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const size = Math.round(Number(r.shelfSize));
  return {
    archiveOnRemove: typeof r.archiveOnRemove === 'boolean' ? r.archiveOnRemove : SETTINGS_DEFAULTS.archiveOnRemove,
    shelfSize:       Number.isFinite(size) && size >= 1 && size <= MAX_ALBUMS ? size : SETTINGS_DEFAULTS.shelfSize,
    shopUrl:         typeof r.shopUrl === 'string' && /^https?:\/\/\S+$/i.test(r.shopUrl.trim()) ? r.shopUrl.trim().slice(0, 500) : SETTINGS_DEFAULTS.shopUrl,
    archiveView:     ['mosaic', 'list'].includes(r.archiveView) ? r.archiveView : SETTINGS_DEFAULTS.archiveView,
    preferredFormat: ['Vinyl', 'CD'].includes(r.preferredFormat) ? r.preferredFormat : SETTINGS_DEFAULTS.preferredFormat,
  };
}

function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('That file isn\'t a readable backup.'); }
  if (!obj || obj.app !== 'LPQ' || !Array.isArray(obj.albums)) throw new Error('That doesn\'t look like an LPQ backup.');
  if (Number(obj.backupVersion) > BACKUP_VERSION) throw new Error('That backup was made by a newer version of LPQ. Update the app first.');
  if (obj.albums.length > BACKUP_MAX_ALBUMS) throw new Error('That backup is too large to import.');
  const seenIds = new Set();
  const imported = [];
  let skipped = 0;
  for (const raw of obj.albums) {
    const a = sanitizeAlbum(raw);
    if (!a) { skipped++; continue; }
    if (seenIds.has(a.id)) a.id = uid();
    seenIds.add(a.id);
    imported.push(a);
  }
  if (!imported.length && obj.albums.length) throw new Error('None of the albums in that file could be read.');
  return { albums: imported, settings: sanitizeSettings(obj.settings), skipped, exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : null };
}

function describeBackup(b) {
  const n = { shelf: 0, vinyl: 0, prerelease: 0, archive: 0 };
  for (const a of b.albums) n[albumSection(a)]++;
  const when = b.exportedAt && !isNaN(new Date(b.exportedAt)) ? ` Saved ${formatReleaseDate(localISODate(new Date(b.exportedAt)))}.` : '';
  return `${b.albums.length} album${b.albums.length === 1 ? '' : 's'}: ${n.shelf} on Shelf, ${n.vinyl} on Get Physical, ${n.prerelease} in Pre-Releases, ${n.archive} in Archive.${when}` +
    (b.skipped ? ` ${b.skipped} unreadable entr${b.skipped === 1 ? 'y' : 'ies'} will be left out.` : '');
}

// Artist and countdown date from a read page. Full pages title themselves
// "<Album> - Upcoming Album by <Artist>"; embed pages use "<Album> - <Artist>".
function parseReleasePage(text, { embed = false } = {}) {
  if (!text) return null;
  let releaseDate = null;
  const dm = text.match(/Releases on ([A-Za-z]+ \d{1,2}, \d{4})/);
  if (dm) {
    const parsed = new Date(dm[1]);
    if (!isNaN(parsed)) {
      releaseDate = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    }
  }
  const am = text.match(/^Title: .+? - (?:Upcoming )?(?:Album|Single|EP|Compilation) by (.+?)(?: \| Spotify)?\s*$/m)
          || (embed ? text.match(/^Title: .+ - (.+?)\s*$/m) : null);
  const artist = am ? am[1].replace(/\s*\|\s*Spotify\s*$/i, '').trim() || null : null;
  return releaseDate || artist ? { releaseDate, artist } : null;
}

// Vinyl wishlist: large square artwork on the left, artist/title/year beside.
// Buy and Remove live in the long-press menu (same pattern as the shelf).
// Your record shop's search page for an album, in your preferred format. Shared
// by the long-press "Buy on …" action and the tap on Get Physical artwork.
function shopSearchUrl(a, cfg = settings) {
  const base   = cfg.shopUrl || SETTINGS_DEFAULTS.shopUrl;
  const format = cfg.preferredFormat || SETTINGS_DEFAULTS.preferredFormat;
  return base + encodeURIComponent([a.artist, a.title, format].filter(Boolean).join(' '));
}

// ─── Pre-release promotion (the rule behind checkPreReleases in app.js) ────────
// Mutates `albums` in place. Returns which albums were promoted to the shelf so
// the caller can move them to the front once the loop is over.
function applyPreReleaseRules(albums, shelfSize, now = Date.now(), today = localISODate()) {
  let changed = false;
  const promotedIds = [];
  for (const a of albums) {
    if (!a.preRelease) continue;
    // Never auto-promote if we don't have a date to check against
    if (!a.releaseDate && !a.spotifyUrl?.includes('/prerelease/')) continue;
    if (isPreRelease(a.releaseDate, a.spotifyUrl, today)) continue; // not released yet

    const shelfFull = albums.filter(
      x => !x.archived && !x.preRelease && !x.detached
    ).length >= shelfSize;

    if (!shelfFull) {
      // Room available — promote straight to the shelf, whether this is the
      // first time we've noticed it released or it's been waiting a while.
      a.preRelease = false;
      delete a.shelfFullSince;
      changed = true;
      promotedIds.push(a.id);
    } else if (!a.shelfFullSince) {
      // First time we've seen it released with no room — start the 7-day
      // clock. Stays in Pre-Releases with the "Shelf Full" badge.
      a.shelfFullSince = now;
      changed = true;
    } else if (now - a.shelfFullSince >= SHELF_FULL_GRACE_MS) {
      // Grace period elapsed and still no room — archive it for good.
      a.preRelease = false;
      a.archived   = true;
      delete a.shelfFullSince;
      changed = true;
    }
    // else: still within the grace window and shelf still full — leave as-is.
  }
  return { changed, promotedIds };
}

// ─── Duplicates and import merging ────────────────────────────────────────────
// Already in the collection (any tab, archive included)? Match on Spotify id,
// or on title + artist since Get Physical entries store no URL.
function findExistingIn(list, r) {
  const key = normAlbumKey(r.title) + '|' + normAlbumKey(r.artist);
  return list.find(a =>
    (a.spotifyUrl && extractAlbumId(a.spotifyUrl) === r.id) ||
    (normAlbumKey(a.title) + '|' + normAlbumKey(a.artist)) === key
  ) || null;
}

// Add only what isn't owned already (same Spotify album, or same title + artist).
// Pushes onto `existing` and may change `a.id` / `a.archived` on the incoming
// albums. A full shelf can't take more, so extras are parked in Archive.
function mergeAlbums(existing, incoming, shelfSize) {
  const key = a => normAlbumKey(a.title) + '|' + normAlbumKey(a.artist);
  const ids = new Set(existing.map(a => a.spotifyUrl && extractAlbumId(a.spotifyUrl)).filter(Boolean));
  const keys = new Set(existing.map(key));
  const usedIds = new Set(existing.map(a => a.id));
  let onShelf = existing.filter(a => albumSection(a) === 'shelf').length;
  let added = 0, dupes = 0, toArchive = 0;
  for (const a of incoming) {
    const sid = a.spotifyUrl && extractAlbumId(a.spotifyUrl);
    if ((sid && ids.has(sid)) || keys.has(key(a))) { dupes++; continue; }
    if (usedIds.has(a.id)) a.id = uid();
    if (albumSection(a) === 'shelf') {
      if (onShelf >= shelfSize) { a.archived = true; toArchive++; } else onShelf++;
    }
    if (sid) ids.add(sid);
    keys.add(key(a)); usedIds.add(a.id);
    existing.push(a);
    added++;
  }
  return { added, dupes, toArchive };
}
