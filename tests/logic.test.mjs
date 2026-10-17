// Tests for logic.js (LPQ's rules). Run with:  npm test
// logic.js is a plain browser script, so it's loaded here the same way a page
// would load it: evaluated in a fresh context with only what a browser provides.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const NAMES = [
  'SETTINGS_DEFAULTS', 'MAX_ALBUMS', 'SHELF_FULL_GRACE_MS', 'BACKUP_VERSION', 'BACKUP_MAX_ALBUMS',
  'uid', 'localISODate', 'isPreRelease', 'formatReleaseDate', 'extractAlbumId', 'toSpotifyUri',
  'normAlbumKey', 'albumLocation', 'albumSection', 'isAlbumOrEp', 'toSearchResult', 'cleanStr',
  'sanitizeAlbum', 'sanitizeSettings', 'parseBackup', 'describeBackup', 'parseReleasePage',
  'shopSearchUrl', 'applyPreReleaseRules', 'findExistingIn', 'mergeAlbums',
];
const src = fs.readFileSync(new URL('../logic.js', import.meta.url), 'utf8');
// Run in this process's own context so objects it creates compare cleanly in assertions.
const L = vm.runInThisContext(`${src}\n({ ${NAMES.join(', ')} })`, { filename: 'logic.js' });

const DAY = 24 * 60 * 60 * 1000;
const TODAY = '2026-10-17';
const album = (o = {}) => ({
  id: Math.random().toString(36).slice(2), title: 'T', artist: 'A', art: null, spotifyUrl: null, year: null,
  releaseDate: null, label: null, addedAt: 1, vinyl: false, detached: false, archived: false, preRelease: false, ...o,
});
const pre = (o = {}) => album({ preRelease: true, releaseDate: '2026-10-01', ...o });

// ─── dates ─────────────────────────────────────────────────────────────────────
test('isPreRelease: dates', () => {
  assert.equal(L.isPreRelease('2026-10-16', null, TODAY), false, 'yesterday is released');
  assert.equal(L.isPreRelease('2026-10-17', null, TODAY), false, 'today is released');
  assert.equal(L.isPreRelease('2026-10-18', null, TODAY), true, 'tomorrow is not');
  assert.equal(L.isPreRelease('2027-01-22', null, TODAY), true);
  assert.equal(L.isPreRelease(null, null, TODAY), false, 'no date and no pre-release link');
});

test('isPreRelease: pre-release links and past dates', () => {
  const pr = 'https://open.spotify.com/prerelease/abc';
  assert.equal(L.isPreRelease(null, pr, TODAY), true, 'a /prerelease/ link with no date is a pre-release');
  assert.equal(L.isPreRelease('2027-01-01', pr, TODAY), true);
  assert.equal(L.isPreRelease('2026-01-01', pr, TODAY), false, 'a confirmed past date beats the link');
  assert.equal(L.isPreRelease('1996-06-10', 'https://open.spotify.com/album/abc', TODAY), false);
});

test('isPreRelease: year-only and month-only dates', () => {
  assert.equal(L.isPreRelease('2026', null, TODAY), false);
  assert.equal(L.isPreRelease('2027', null, TODAY), true);
  assert.equal(L.isPreRelease('2026-10', null, TODAY), false);
  assert.equal(L.isPreRelease('2026-11', null, TODAY), true);
});

test('localISODate uses the local calendar day, not UTC', () => {
  assert.equal(L.localISODate(new Date(2026, 9, 5, 0, 30)), '2026-10-05');
  assert.equal(L.localISODate(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.match(L.localISODate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('formatReleaseDate', () => {
  assert.equal(L.formatReleaseDate('2026-11-13'), '13 Nov 2026');
  assert.equal(L.formatReleaseDate('2026-01-05'), '5 Jan 2026');
  assert.equal(L.formatReleaseDate('2026-11'), 'Nov 2026');
  assert.equal(L.formatReleaseDate('2026'), '2026');
  assert.equal(L.formatReleaseDate(''), '');
  assert.equal(L.formatReleaseDate(null), '');
});

// ─── links ─────────────────────────────────────────────────────────────────────
test('extractAlbumId', () => {
  assert.equal(L.extractAlbumId('https://open.spotify.com/album/4ZYnr7sAQw83pQxf0l72JB?si=abc'), '4ZYnr7sAQw83pQxf0l72JB');
  assert.equal(L.extractAlbumId('https://open.spotify.com/prerelease/3aEsud3bKKWoSOKqzsZewK?utm_source=x'), '3aEsud3bKKWoSOKqzsZewK');
  assert.equal(L.extractAlbumId('https://open.spotify.com/intl-fr/album/abc123'), 'abc123');
  assert.equal(L.extractAlbumId('https://open.spotify.com/artist/abc'), null);
  assert.equal(L.extractAlbumId('not a url'), null);
  assert.equal(L.extractAlbumId(''), null);
  assert.equal(L.extractAlbumId('https://open.spotify.com/album/'), null);
});

test('toSpotifyUri', () => {
  assert.equal(L.toSpotifyUri('https://open.spotify.com/album/abc?si=1'), 'spotify:album:abc');
  assert.equal(L.toSpotifyUri('spotify:album:abc'), 'spotify:album:abc');
  assert.equal(L.toSpotifyUri('https://open.spotify.com/prerelease/abc'), 'https://open.spotify.com/prerelease/abc');
  assert.equal(L.toSpotifyUri(null), null);
});

test('shopSearchUrl: shop, format, awkward names', () => {
  const cfg = { shopUrl: 'https://shop.test/s?q=', preferredFormat: 'CD' };
  assert.equal(L.shopSearchUrl({ artist: 'Hiroshi Yoshimura', title: 'Quiet Forest' }, cfg), 'https://shop.test/s?q=Hiroshi%20Yoshimura%20Quiet%20Forest%20CD');
  assert.equal(L.shopSearchUrl({ artist: 'Mr. Foo / Bar', title: 'Hymns & Raps' }, cfg), 'https://shop.test/s?q=Mr.%20Foo%20%2F%20Bar%20Hymns%20%26%20Raps%20CD');
  assert.equal(L.shopSearchUrl({ artist: '', title: 'Untitled' }, cfg), 'https://shop.test/s?q=Untitled%20CD', 'no artist: no stray space');
  assert.equal(L.shopSearchUrl({ artist: 'A', title: 'B' }, { shopUrl: '', preferredFormat: '' }),
    L.SETTINGS_DEFAULTS.shopUrl + 'A%20B%20' + L.SETTINGS_DEFAULTS.preferredFormat, 'blank settings fall back to defaults');
});

// ─── sections, search results, duplicates ──────────────────────────────────────
test('albumSection / albumLocation priority: archive > pre-release > get physical > shelf', () => {
  assert.equal(L.albumSection(album()), 'shelf');
  assert.equal(L.albumSection(album({ vinyl: true })), 'vinyl');
  assert.equal(L.albumSection(album({ detached: true })), 'vinyl');
  assert.equal(L.albumSection(album({ preRelease: true, vinyl: true })), 'prerelease');
  assert.equal(L.albumSection(album({ archived: true, preRelease: true, vinyl: true })), 'archive');
  assert.equal(L.albumLocation(album({ archived: true })), 'Archive');
  assert.equal(L.albumLocation(album({ preRelease: true })), 'Pre-Releases');
  assert.equal(L.albumLocation(album({ vinyl: true })), 'Get Physical');
  assert.equal(L.albumLocation(album()), 'Shelf');
});

test('isAlbumOrEp keeps albums and EPs, drops singles', () => {
  assert.equal(L.isAlbumOrEp({ album_type: 'album', total_tracks: 12 }), true);
  assert.equal(L.isAlbumOrEp({ album_type: 'album', total_tracks: 1 }), true);
  assert.equal(L.isAlbumOrEp({ album_type: 'compilation', total_tracks: 19 }), true);
  assert.equal(L.isAlbumOrEp({ album_type: 'single', total_tracks: 1 }), false);
  assert.equal(L.isAlbumOrEp({ album_type: 'single', total_tracks: 3 }), false);
  assert.equal(L.isAlbumOrEp({ album_type: 'single', total_tracks: 4 }), true, '4+ track "single" is an EP');
  assert.equal(L.isAlbumOrEp({ album_type: 'single', total_tracks: 6 }), true);
  assert.equal(L.isAlbumOrEp({ album_type: 'single' }), false);
  assert.equal(L.isAlbumOrEp({ album_type: 'appears_on', total_tracks: 9 }), false);
});

test('toSearchResult', () => {
  const r = L.toSearchResult({
    id: 'abc', name: 'Cala', album_type: 'album', release_date: '2019-08-09',
    artists: [{ name: 'Fionn Regan' }, { name: 'Guest' }],
    images: [{ url: 'big' }, { url: 'mid' }, { url: 'small' }],
    external_urls: { spotify: 'https://open.spotify.com/album/abc' },
  });
  assert.deepEqual(r, { id: 'abc', title: 'Cala', artist: 'Fionn Regan, Guest', thumb: 'mid', art: 'big', spotifyUrl: 'https://open.spotify.com/album/abc', releaseDate: '2019-08-09', year: '2019' });
  const bare = L.toSearchResult({ id: 'zzz', name: 'X', images: [{ url: 'only' }] });
  assert.equal(bare.thumb, 'only');
  assert.equal(bare.spotifyUrl, 'https://open.spotify.com/album/zzz');
  assert.equal(bare.year, null);
  assert.equal(bare.artist, '');
});

test('normAlbumKey ignores case, accents and punctuation', () => {
  assert.equal(L.normAlbumKey('Beyoncé — Lemonade!'), 'beyonce lemonade');
  assert.equal(L.normAlbumKey('  FIONN   regan '), 'fionn regan');
  assert.equal(L.normAlbumKey(null), '');
});

test('findExistingIn matches by Spotify id or by title + artist', () => {
  const list = [
    album({ id: '1', title: 'The End of History', artist: 'Fionn Regan', spotifyUrl: 'https://open.spotify.com/album/AAA111' }),
    album({ id: '2', title: 'Slow Hours EP', artist: 'Fionn Regan', vinyl: true, detached: true }),
  ];
  assert.equal(L.findExistingIn(list, { id: 'AAA111', title: 'Different Title', artist: 'Other' }), list[0], 'by id');
  assert.equal(L.findExistingIn(list, { id: 'x', title: 'slow hours ep', artist: 'FIONN REGAN' }), list[1], 'by title and artist, no URL stored');
  assert.equal(L.findExistingIn(list, { id: 'x', title: 'Slow Hours', artist: 'Fionn Regan' }), null);
  assert.equal(L.findExistingIn([], { id: 'x', title: 'A', artist: 'B' }), null);
});

// ─── parsing Spotify pages ─────────────────────────────────────────────────────
const page = (title, extra = '') => `Title: ${title}\n\nURL Source: x\n\nMarkdown Content:\n${extra}`;

test('parseReleasePage handles every title shape seen so far', () => {
  assert.deepEqual(L.parseReleasePage(page('Frogs In A Pond - Upcoming Album by Surprise Chef', 'Releases on October 23, 2026')), { releaseDate: '2026-10-23', artist: 'Surprise Chef' });
  assert.deepEqual(L.parseReleasePage(page('Frogs In A Pond - Surprise Chef', 'Releases on October 23, 2026'), { embed: true }), { releaseDate: '2026-10-23', artist: 'Surprise Chef' });
  assert.deepEqual(L.parseReleasePage(page('Cookie Happened - Eels | Spotify'), { embed: true }), { releaseDate: null, artist: 'Eels' }, 'strips the "| Spotify" suffix');
  assert.deepEqual(L.parseReleasePage(page('Listen to The Cat - Album by Jimmy Smith')), { releaseDate: null, artist: 'Jimmy Smith' });
  assert.deepEqual(L.parseReleasePage(page('Berlin, Berlin - Upcoming Album by Fionn Regan | Spotify')), { releaseDate: null, artist: 'Fionn Regan' });
  assert.deepEqual(L.parseReleasePage(page('Some Album - Upcoming Album by Jay-Z - Remix Crew')), { releaseDate: null, artist: 'Jay-Z - Remix Crew' });
  assert.equal(L.parseReleasePage('hello'), null);
  assert.equal(L.parseReleasePage(null), null);
});

test('parseReleasePage only trusts the embed title format when asked to', () => {
  assert.equal(L.parseReleasePage(page('Frogs In A Pond - Surprise Chef')), null, 'plain pages need "Album by"');
});

test('parseReleasePage reads dates in any month', () => {
  const d = s => L.parseReleasePage(page('X - Upcoming Album by Y', `Releases on ${s}`)).releaseDate;
  assert.equal(d('January 2, 2027'), '2027-01-02');
  assert.equal(d('December 31, 2026'), '2026-12-31');
  assert.equal(d('February 9, 2027'), '2027-02-09');
});

// ─── pre-release promotion (this rule moves and archives albums on its own) ─────
const NOW = Date.UTC(2026, 9, 17, 12);
const rules = (albums, shelfSize = 12) => L.applyPreReleaseRules(albums, shelfSize, NOW, TODAY);

test('promotes a released pre-release when the shelf has room', () => {
  const a = pre({ id: 'a', shelfFullSince: NOW - DAY });
  const r = rules([a]);
  assert.equal(a.preRelease, false);
  assert.equal('shelfFullSince' in a, false);
  assert.deepEqual(r, { changed: true, promotedIds: ['a'] });
});

test('leaves unreleased pre-releases alone', () => {
  const a = pre({ releaseDate: '2026-10-23' });
  const r = rules([a]);
  assert.equal(a.preRelease, true);
  assert.equal(r.changed, false);
});

test('never promotes without a date, unless it is a /prerelease/ link with no date yet', () => {
  const noDate = pre({ releaseDate: null, spotifyUrl: 'https://open.spotify.com/album/abc' });
  const link = pre({ releaseDate: null, spotifyUrl: 'https://open.spotify.com/prerelease/abc' });
  const r = rules([noDate, link]);
  assert.equal(noDate.preRelease, true);
  assert.equal(link.preRelease, true);
  assert.equal(r.changed, false);
});

test('a full shelf starts a 7-day wait instead of archiving straight away', () => {
  const shelf = Array.from({ length: 12 }, () => album());
  const a = pre();
  const r = rules([...shelf, a], 12);
  assert.equal(a.preRelease, true);
  assert.equal(a.archived, false);
  assert.equal(a.shelfFullSince, NOW);
  assert.deepEqual(r, { changed: true, promotedIds: [] });
});

test('still waiting inside the 7 days: no change', () => {
  const shelf = Array.from({ length: 12 }, () => album());
  const a = pre({ shelfFullSince: NOW - 6 * DAY });
  const r = rules([...shelf, a], 12);
  assert.equal(r.changed, false);
  assert.equal(a.preRelease, true);
  assert.equal(a.shelfFullSince, NOW - 6 * DAY);
});

test('after 7 days with the shelf still full it is archived', () => {
  const shelf = Array.from({ length: 12 }, () => album());
  const a = pre({ shelfFullSince: NOW - 7 * DAY });
  const r = rules([...shelf, a], 12);
  assert.equal(a.preRelease, false);
  assert.equal(a.archived, true);
  assert.equal('shelfFullSince' in a, false);
  assert.equal(r.changed, true);
  assert.equal(L.SHELF_FULL_GRACE_MS, 7 * DAY);
});

test('room opening up during the wait promotes it instead', () => {
  const shelf = Array.from({ length: 11 }, () => album());
  const a = pre({ id: 'late', shelfFullSince: NOW - 3 * DAY });
  rules([...shelf, a], 12);
  assert.equal(a.preRelease, false);
  assert.equal(a.archived, false);
});

test('only albums actually on the shelf count towards the limit', () => {
  const others = [album({ archived: true }), album({ vinyl: true, detached: true }), album({ preRelease: true, releaseDate: '2099-01-01' })];
  const a = pre({ id: 'p' });
  rules([...others, a], 1);
  assert.equal(a.preRelease, false, 'archive, Get Physical and pre-releases do not fill the shelf');
});

test('two released pre-releases and one free slot: one promoted, one waits', () => {
  const shelf = Array.from({ length: 11 }, () => album());
  const first = pre({ id: 'first' }), second = pre({ id: 'second' });
  const r = rules([...shelf, first, second], 12);
  assert.equal(first.preRelease, false);
  assert.equal(second.preRelease, true);
  assert.equal(second.shelfFullSince, NOW);
  assert.deepEqual(r.promotedIds, ['first']);
});

// ─── import safety ─────────────────────────────────────────────────────────────
test('sanitizeAlbum keeps a good album and drops unknown fields', () => {
  const good = { id: 'g1', title: 'Cala', artist: 'Fionn Regan', art: 'https://i.scdn.co/image/x', spotifyUrl: 'https://open.spotify.com/album/5N1201PBNTiy1gj7b7sPsW',
    year: '2019', releaseDate: '2019-08-09', label: 'Label', addedAt: 1700000000000, vinyl: false, detached: false, archived: false, preRelease: false, extra: 'x', onclick: 'y' };
  const a = L.sanitizeAlbum(good);
  const { extra, onclick, ...expected } = good;
  assert.deepEqual(a, expected);
});

test('sanitizeAlbum rejects unsafe links', () => {
  for (const spotifyUrl of ['javascript:alert(1)//open.spotify.com/prerelease/abc', 'data:text/html,x', 'http://open.spotify.com/album/abc', 'https://evil.example/open.spotify.com/album/abc', 'https://open.spotify.com.evil.example/album/abc', 'spotify:album:abc']) {
    assert.equal(L.sanitizeAlbum({ title: 'T', spotifyUrl }).spotifyUrl, null, spotifyUrl);
  }
  for (const art of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'http://i.scdn.co/x', '//i.scdn.co/x']) {
    assert.equal(L.sanitizeAlbum({ title: 'T', art }).art, null, art);
  }
  assert.equal(L.sanitizeAlbum({ title: 'T', spotifyUrl: 'https://open.spotify.com/prerelease/3aEsud3bKKWoSOKqzsZewK' }).spotifyUrl, 'https://open.spotify.com/prerelease/3aEsud3bKKWoSOKqzsZewK');
});

test('sanitizeAlbum enforces types and limits', () => {
  assert.equal(L.sanitizeAlbum({ title: '' }), null);
  assert.equal(L.sanitizeAlbum({ title: '   ' }), null);
  assert.equal(L.sanitizeAlbum({}), null);
  assert.equal(L.sanitizeAlbum(null), null);
  assert.equal(L.sanitizeAlbum('str'), null);
  const a = L.sanitizeAlbum({ title: 'T'.repeat(1000), artist: 'A'.repeat(1000), vinyl: 'true', archived: 1, preRelease: null, year: 'abcd', releaseDate: 'tomorrow', label: 12, addedAt: 'soon' });
  assert.equal(a.title.length, 300);
  assert.equal(a.artist.length, 300);
  assert.equal(a.vinyl, false);
  assert.equal(a.archived, false);
  assert.equal(a.preRelease, false);
  assert.equal(a.year, null);
  assert.equal(a.releaseDate, null);
  assert.equal(a.label, null);
  assert.equal(typeof a.addedAt, 'number');
  assert.ok(a.id.length > 0, 'an id is generated when missing');
});

test('sanitizeAlbum keeps meaningful values: empty label, numeric year, date precision, shelfFullSince', () => {
  assert.equal(L.sanitizeAlbum({ title: 'T', label: '' }).label, '', "'' means looked up, no match");
  assert.equal(L.sanitizeAlbum({ title: 'T', year: 2019 }).year, '2019');
  assert.equal(L.sanitizeAlbum({ title: 'T', releaseDate: '2019' }).releaseDate, '2019');
  assert.equal(L.sanitizeAlbum({ title: 'T', releaseDate: '2019-05' }).releaseDate, '2019-05');
  assert.equal(L.sanitizeAlbum({ title: 'T', shelfFullSince: 1700000000000 }).shelfFullSince, 1700000000000);
  assert.equal('shelfFullSince' in L.sanitizeAlbum({ title: 'T', shelfFullSince: 'x' }), false);
  assert.equal(L.sanitizeAlbum({ title: '<img src=x onerror=alert(1)>' }).title, '<img src=x onerror=alert(1)>', 'kept as text; the app escapes it when drawing');
});

test('sanitizeSettings falls back to defaults on bad input', () => {
  const D = L.SETTINGS_DEFAULTS;
  assert.deepEqual(L.sanitizeSettings(undefined), D);
  assert.deepEqual(L.sanitizeSettings('nope'), D);
  const s = L.sanitizeSettings({ shelfSize: 9999, shopUrl: 'javascript:alert(1)', archiveView: 'evil', preferredFormat: '<img>', archiveOnRemove: 'yes' });
  assert.deepEqual(s, D);
  assert.equal(L.sanitizeSettings({ shelfSize: 0 }).shelfSize, D.shelfSize);
  assert.equal(L.sanitizeSettings({ shelfSize: 4 }).shelfSize, 4);
  assert.equal(L.sanitizeSettings({ shelfSize: L.MAX_ALBUMS }).shelfSize, L.MAX_ALBUMS);
  assert.equal(L.sanitizeSettings({ shelfSize: L.MAX_ALBUMS + 1 }).shelfSize, D.shelfSize);
  assert.deepEqual(L.sanitizeSettings({ archiveOnRemove: false, shelfSize: 8, shopUrl: 'https://shop.test/s?q=', archiveView: 'list', preferredFormat: 'CD' }),
    { archiveOnRemove: false, shelfSize: 8, shopUrl: 'https://shop.test/s?q=', archiveView: 'list', preferredFormat: 'CD' });
});

test('parseBackup rejects things that are not LPQ backups', () => {
  const bad = (text, msg) => assert.throws(() => L.parseBackup(text), msg);
  bad('hello this is not json', /readable backup/);
  bad('', /readable backup/);
  bad(JSON.stringify({ app: 'Other', albums: [] }), /doesn't look like an LPQ backup/);
  bad(JSON.stringify({ app: 'LPQ', albums: 'nope' }), /doesn't look like an LPQ backup/);
  bad(JSON.stringify([1, 2, 3]), /doesn't look like an LPQ backup/);
  bad(JSON.stringify(null), /doesn't look like an LPQ backup/);
  bad(JSON.stringify({ app: 'LPQ', backupVersion: 99, albums: [{ title: 'A' }] }), /newer version/);
  bad(JSON.stringify({ app: 'LPQ', backupVersion: 1, albums: [{}, { title: '' }, 5, null] }), /None of the albums/);
  bad(JSON.stringify({ app: 'LPQ', backupVersion: 1, albums: new Array(L.BACKUP_MAX_ALBUMS + 1).fill({ title: 'x' }) }), /too large/);
});

test('parseBackup accepts an empty collection and counts unreadable entries', () => {
  assert.deepEqual(L.parseBackup(JSON.stringify({ app: 'LPQ', backupVersion: 1, albums: [] })).albums, []);
  const b = L.parseBackup(JSON.stringify({ app: 'LPQ', backupVersion: 1, albums: [{ title: 'One' }, null, { title: 'Two' }, 'x'] }));
  assert.equal(b.albums.length, 2);
  assert.equal(b.skipped, 2);
});

test('parseBackup gives duplicate ids a fresh id and sanitises settings', () => {
  const b = L.parseBackup(JSON.stringify({ app: 'LPQ', backupVersion: 1, settings: { shelfSize: 8, shopUrl: 'javascript:x' },
    albums: [{ id: 'same', title: 'A' }, { id: 'same', title: 'B' }] }));
  assert.equal(new Set(b.albums.map(a => a.id)).size, 2);
  assert.equal(b.settings.shelfSize, 8);
  assert.equal(b.settings.shopUrl, L.SETTINGS_DEFAULTS.shopUrl);
});

test('a backup round-trips without losing anything', () => {
  const albums = [
    album({ id: 'a', title: 'Cala', artist: 'Fionn Regan', art: 'https://i.scdn.co/image/x', spotifyUrl: 'https://open.spotify.com/album/5N1201PBNTiy1gj7b7sPsW', year: '2019', releaseDate: '2019-08-09', label: 'Label' }),
    album({ id: 'b', title: 'Slow Hours EP', vinyl: true, detached: true, label: '' }),
    album({ id: 'c', title: 'Waiting', preRelease: true, releaseDate: '2099-01-01', spotifyUrl: 'https://open.spotify.com/prerelease/3aEsud3bKKWoSOKqzsZewK', shelfFullSince: 5 }),
    album({ id: 'd', title: 'Old', archived: true, year: null }),
  ];
  const settings = { archiveOnRemove: false, shelfSize: 16, shopUrl: 'https://shop.test/s?q=', archiveView: 'list', preferredFormat: 'CD' };
  const back = L.parseBackup(JSON.stringify({ app: 'LPQ', backupVersion: 1, exportedAt: '2026-10-17T10:00:00Z', settings, albums }));
  assert.deepEqual(back.albums, albums);
  assert.deepEqual(back.settings, settings);
  assert.equal(back.skipped, 0);
});

test('describeBackup counts each section', () => {
  const text = L.describeBackup({ exportedAt: null, skipped: 0, albums: [
    album(), album(), album({ vinyl: true }), album({ preRelease: true }), album({ archived: true }) ] });
  assert.match(text, /^5 albums: 2 on Shelf, 1 on Get Physical, 1 in Pre-Releases, 1 in Archive\.$/);
  assert.match(L.describeBackup({ exportedAt: null, skipped: 2, albums: [album()] }), /^1 album: .* 2 unreadable entries will be left out\.$/);
});

// ─── import merge ──────────────────────────────────────────────────────────────
test('mergeAlbums skips albums you already own', () => {
  const existing = [
    album({ id: '1', title: 'The End of History', artist: 'Fionn Regan', spotifyUrl: 'https://open.spotify.com/album/AAA111' }),
    album({ id: '2', title: 'Cala', artist: 'Fionn Regan', archived: true }),
  ];
  const incoming = [
    album({ id: 'x1', title: 'Whatever', artist: 'Else', spotifyUrl: 'https://open.spotify.com/album/AAA111' }),   // same Spotify album
    album({ id: 'x2', title: 'cala', artist: 'FIONN  regan' }),                                                      // same title + artist
    album({ id: 'x3', title: 'Brand New', artist: 'Band' }),
    album({ id: 'x4', title: 'Brand New', artist: 'Band' }),                                                         // duplicate inside the file
  ];
  const r = L.mergeAlbums(existing, incoming, 12);
  assert.deepEqual(r, { added: 1, dupes: 3, toArchive: 0 });
  assert.equal(existing.length, 3);
  assert.equal(existing[2].title, 'Brand New');
});

test('mergeAlbums parks extras in Archive when the shelf is full', () => {
  const existing = [album({ id: 'e1' }), album({ id: 'e2' })];
  const incoming = Array.from({ length: 4 }, (_, i) => album({ id: 'n' + i, title: 'New ' + i, artist: 'B' + i }));
  const r = L.mergeAlbums(existing, incoming, 3);
  assert.deepEqual(r, { added: 4, dupes: 0, toArchive: 3 });
  assert.equal(existing.filter(a => L.albumSection(a) === 'shelf').length, 3);
  assert.equal(existing.filter(a => a.archived).length, 3);
});

test('mergeAlbums only counts shelf albums against the limit', () => {
  const existing = [album({ id: 'e1' })];
  const incoming = [
    album({ id: 'v', title: 'Wishlist', vinyl: true, detached: true }),
    album({ id: 'p', title: 'Soon', preRelease: true, releaseDate: '2099-01-01' }),
    album({ id: 'a', title: 'Old', archived: true }),
    album({ id: 's', title: 'Shelf one' }),
  ];
  const r = L.mergeAlbums(existing, incoming, 2);
  assert.deepEqual(r, { added: 4, dupes: 0, toArchive: 0 });
  assert.equal(existing.find(a => a.id === 's').archived, false);
});

test('mergeAlbums gives clashing ids a fresh id', () => {
  const existing = [album({ id: 'same', title: 'Mine' })];
  const incoming = [album({ id: 'same', title: 'Theirs', artist: 'Else' })];
  L.mergeAlbums(existing, incoming, 12);
  assert.equal(new Set(existing.map(a => a.id)).size, 2);
});

test('uid returns unique ids', () => {
  const ids = new Set(Array.from({ length: 200 }, () => L.uid()));
  assert.equal(ids.size, 200);
});
