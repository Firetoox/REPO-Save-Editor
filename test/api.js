'use strict';
// Tests of the HTTP backend. Without arguments it runs on synthetic test files (test/fixtures.js).
// With your own files only on COPIES, never the originals:
//   node test/api.js <savesDirCopy> <metaSaveCopy> <emptyWorkDir>

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const assert = require('assert');
const { test, before, after } = require('node:test');
const { testFiles, startEditor } = require('./helpers');
const { maskPaths } = require('../lib/server');
const es3 = require('../lib/es3');
const { UNKNOWN_UNLOCK } = require('./fixtures');
// the shipped cosmetic list: the same as the game's own list of the tested build
const COSMETICS = require('../lib/cosmetics.json').length;

const files = testFiles(process.argv.slice(2), 'Only run with copies: node test/api.js <savesDirCopy> <metaSaveCopy> <workDir>');
fs.mkdirSync(files.work, { recursive: true });

/** Request with freely chosen headers (fetch cannot set Host). Resolves with the status code. */
function rawRequest(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body !== undefined ? body : method === 'POST' ? '{}' : undefined);
  });
}

// The checks share one running editor and one save. They run in order, and some build on what an
// earlier one left (for example the original backup made before the first check).
let gameRunning = false;
const opened = [];
const dd = json => json.dictionaryOfDictionaries.value;
let editor, port, call, ok, state, id, file;
/** Hash of the save as the editor reads it now (what the page would have loaded). */
const saveHash = async () => (await ok('GET', '/api/save?id=' + id)).hash;

before(async () => {
  ({ editor, port, call, ok } = await startEditor(files, {
    skipGameCheck: false,
    isGameRunning: async () => gameRunning,
    openFolder: dir => opened.push(dir)
  }));
  editor.backupOriginals();
  state = await ok('GET', '/api/state');
  // the first save with upgrade purchases (the synthetic "Demo Crew" has some)
  const saves = await ok('GET', '/api/saves');
  id = saves[0].id;
  for (const t of saves) {
    if (Object.keys((await ok('GET', '/api/save?id=' + t.id)).model.upgradesPurchased).length) { id = t.id; break; }
  }
  file = path.join(files.savesDir, id, id + '.es3');
});
after(() => editor && editor.close());

test('State: lists, limits, game folder and password', async () => {
  // the fake game of the synthetic files has no item or cosmetic data: built-in lists; real game: its lists
  const source = files.synthetic ? 'builtin' : 'game';
  assert.strictEqual(state.catalog.source, source);
  assert.strictEqual(state.cosmetics.source, source);
  assert.strictEqual(state.cosmetics.list.length, COSMETICS);
  assert.ok(state.cosmetics.list.every(c => c.rarity !== null && c.colorable !== null), 'rarity and colour flag of every cosmetic');
  assert.ok(state.catalog.items.some(it => it.wip && !it.disabled), 'unfinished items are offered (marked)');
  assert.deepStrictEqual(Object.keys(state.limits).sort(), ['hp', 'itemCount', 'profileName', 'purchases', 'teamName', 'upgradeLevel']);
  assert.ok(state.catalog.run.every(f => f.key && f.label && f.hint !== undefined));
  assert.strictEqual(state.gameDir, files.gameDir);
  assert.deepStrictEqual(state.password, { found: true }, 'password from the game file');
  assert.strictEqual(state.cosmeticsLockable, true, 'no game update since the cosmetic list was made');
  assert.ok(state.game.testedBuild);
  assert.ok(state.pathAliases.some(([, to]) => to === '%USERPROFILE%'));
});

test('Saving changes only the wanted values (upgrade prices)', async () => {
  const original = files.read(file);
  const s = await ok('GET', '/api/save?id=' + id);
  const keys = Object.keys(s.model.upgradesPurchased);
  assert.ok(keys.length > 0, 'save without upgrade purchases');
  keys.forEach(k => { s.model.upgradesPurchased[k] = 0; });
  const r = await ok('POST', '/api/save?id=' + id, { hash: s.hash, model: s.model });
  assert.ok(r.backup && /_before-save\.es3$/.test(r.backup));
  const written = files.read(file);
  keys.forEach(k => assert.strictEqual(dd(written).itemsUpgradesPurchased[k], 0));
  dd(written).itemsUpgradesPurchased = dd(original).itemsUpgradesPurchased;
  assert.deepStrictEqual(written, original);
});

test('After saving, the new state is backed up too', async () => {
  const s = await ok('GET', '/api/save?id=' + id);
  s.model.run.level += 1;
  await ok('POST', '/api/save?id=' + id, { hash: s.hash, model: s.model });
  const afterSave = (await ok('GET', '/api/backups?id=' + id)).filter(b => b.reason === 'after-save').map(b => b.file).sort();
  assert.ok(afterSave.length, 'no after-save backup');
  assert.ok(fs.readFileSync(path.join(files.work, 'backups', id, afterSave.pop())).equals(fs.readFileSync(file)));
});

test('Refreshing the list backs up a save that changed since its last backup, once', async () => {
  const codec = es3.codec(files.password);
  const json = files.read(file);
  dd(json).runStats.level = 77; // as if the game had saved a new level
  fs.writeFileSync(file, codec.writeSave(json, { encrypted: true }));
  const first = await ok('POST', '/api/rescan', {});
  assert.ok(first.updated.includes(id), JSON.stringify(first.updated));
  const snaps = (await ok('GET', '/api/backups?id=' + id)).filter(b => b.reason === 'snapshot').map(b => b.file).sort();
  assert.ok(fs.readFileSync(path.join(files.work, 'backups', id, snaps.pop())).equals(fs.readFileSync(file)));
  assert.ok(!(await ok('POST', '/api/rescan', {})).updated.includes(id), 'the same state again');
});

test('While the editor runs, every new state the game writes is backed up', async () => {
  const quick = await startEditor(files, { watchDelayMs: 200 });
  try {
    const revision = (await quick.ok('GET', '/api/status')).savesRevision;
    const json = files.read(file);
    dd(json).runStats.level = 78;
    const written = es3.codec(files.password).writeSave(json, { encrypted: true });
    fs.writeFileSync(file, written);
    const backedUp = () => fs.readdirSync(path.join(files.work, 'backups', id)).some(f => fs.readFileSync(path.join(files.work, 'backups', id, f)).equals(written));
    for (let i = 0; i < 50 && !backedUp(); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(backedUp(), 'the new state was not backed up');
    assert.ok((await quick.ok('GET', '/api/status')).savesRevision > revision, 'the page is told about the change');
  } finally {
    await quick.editor.close();
  }
});

test('Inventory: a deleted entry is removed from the save', async () => {
  const s = await ok('GET', '/api/save?id=' + id);
  const key = Object.keys(s.model.inv)[0];
  delete s.model.inv[key];
  await ok('POST', '/api/save?id=' + id, { hash: s.hash, model: s.model, autoBackup: false });
  assert.ok(!(key in dd(files.read(file)).itemsPurchased));
});

test('Saving: checksum missing (400), outdated (409), file unchanged', async () => {
  const s = await ok('GET', '/api/save?id=' + id);
  const bytes = fs.readFileSync(file);
  s.model.run.level = 99;
  assert.strictEqual((await call('POST', '/api/save?id=' + id, { model: s.model })).status, 400);
  assert.strictEqual((await call('POST', '/api/save?id=' + id, { hash: 'outdated', model: s.model })).status, 409);
  assert.ok(fs.readFileSync(file).equals(bytes));
});

test('Nothing is written while the game is running (409)', async () => {
  const s = await ok('GET', '/api/save?id=' + id);
  const m = await ok('GET', '/api/meta');
  const list = await ok('GET', '/api/backups?id=' + id);
  const bytes = fs.readFileSync(file);
  gameRunning = true;
  try {
    assert.strictEqual((await ok('GET', '/api/status')).gameRunning, true);
    const attempts = [
      ['POST', '/api/save?id=' + id, { hash: s.hash, model: s.model }],
      ['POST', '/api/raw?id=' + id, { hash: s.hash, text: JSON.stringify(files.read(file)) }],
      ['POST', '/api/restore?id=' + id, { source: list[0].source, file: list[0].file, hash: s.hash }],
      ['POST', '/api/duplicate?id=' + id, { team: 'x' }],
      ['POST', '/api/meta', { hash: m.hash, unlocks: [] }],
      ['POST', '/api/meta-restore', { source: 'game', file: 'MetaSave.bak', hash: m.hash }]
    ];
    for (const [method, p, body] of attempts) assert.strictEqual((await call(method, p, body)).status, 409, p);
    // the check itself failed (e.g. tasklist blocked): unknown counts as "do not write"
    gameRunning = null;
    assert.strictEqual((await ok('GET', '/api/status')).gameRunning, null);
    for (const [method, p, body] of attempts) {
      const r = await call(method, p, body, { 'X-REPO-Lang': 'en' });
      assert.deepStrictEqual([r.status, /Could not check whether R\.E\.P\.O\. is running/.test(r.data.error)], [409, true], p);
    }
  } finally {
    gameRunning = false;
  }
  assert.ok(fs.readFileSync(file).equals(bytes));
});

test('Refreshing the list removes temp files an interrupted write left behind', async () => {
  const dir = path.join(files.savesDir, id);
  const stale = path.join(dir, id + '.es3.0badc0de.editor-tmp');
  const fresh = path.join(dir, id + '.es3.0000beef.editor-tmp');
  fs.writeFileSync(stale, 'half');
  fs.writeFileSync(fresh, 'in use');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  try {
    await ok('POST', '/api/rescan', {});
    assert.deepStrictEqual([fs.existsSync(stale), fs.existsSync(fresh)], [false, true]);
  } finally {
    fs.rmSync(stale, { force: true });
    fs.rmSync(fresh, { force: true });
  }
});

test('Backups: unique names, restore from editor and game backups', async () => {
  const a = await ok('POST', '/api/backup?id=' + id, {});
  const b = await ok('POST', '/api/backup?id=' + id, {});
  assert.notStrictEqual(a.backup, b.backup);
  const list = await ok('GET', '/api/backups?id=' + id);
  const orig = list.find(x => x.reason === 'original');
  const r = await ok('POST', '/api/restore?id=' + id, { source: 'editor', file: orig.file, hash: await saveHash() });
  assert.ok(/_before-restore\.es3$/.test(r.backup));
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(files.work, 'backups', id, orig.file))));
  const game = list.find(x => x.source === 'game');
  if (game) {
    assert.strictEqual(game.reason, 'game');
    await ok('POST', '/api/restore?id=' + id, { source: 'game', file: game.file, hash: await saveHash() });
    assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(files.savesDir, id, game.file))));
  }
  await ok('POST', '/api/restore?id=' + id, { source: 'editor', file: orig.file, hash: await saveHash() });
  // backups named with German reasons
  const old = path.join(files.work, 'backups', id, '2026-01-01_00-00-00-000_vor-schreiben.es3');
  fs.copyFileSync(file, old);
  try {
    const listed = (await ok('GET', '/api/backups?id=' + id)).find(x => x.file === path.basename(old));
    assert.strictEqual(listed.reason, 'before-save');
  } finally {
    fs.unlinkSync(old);
  }
});

test('Restoring refuses a file that changed since it was loaded (409), nothing is written', async () => {
  const list = await ok('GET', '/api/backups?id=' + id);
  const bytes = fs.readFileSync(file);
  assert.strictEqual((await call('POST', '/api/restore?id=' + id, { source: list[0].source, file: list[0].file })).status, 400, 'hash missing');
  const r = await call('POST', '/api/restore?id=' + id, { source: list[0].source, file: list[0].file, hash: 'outdated' });
  assert.deepStrictEqual([r.status, r.data.reason], [409, 'changed']);
  assert.ok(fs.readFileSync(file).equals(bytes));
  const metaBytes = fs.readFileSync(files.metaFile);
  const m = await call('POST', '/api/meta-restore', { source: 'game', file: 'MetaSave.bak', hash: 'outdated' });
  assert.strictEqual(m.status, fs.existsSync(files.metaFile.replace(/\.es3$/i, '.bak')) ? 409 : 404);
  assert.ok(fs.readFileSync(files.metaFile).equals(metaBytes));
});

test('Invalid IDs and file names are refused', async () => {
  for (const bad of ['..', '..\\..\\x', 'REPO_SAVE_1/../../x', 'C:\\Windows']) {
    assert.strictEqual((await call('GET', '/api/save?id=' + encodeURIComponent(bad))).status, 400, bad);
  }
  assert.strictEqual((await call('GET', '/api/save?id=REPO_SAVE_0')).status, 404);
  assert.strictEqual((await call('GET', '/api/backup-model?id=' + id + '&source=editor&file=..%2F..%2Fx.es3')).status, 400);
  assert.strictEqual((await call('GET', '/api/backup-model?id=' + id + '&source=game&file=REPO_SAVE_1_BACKUP1.es3')).status, 400, 'another save');
  assert.strictEqual((await call('POST', '/api/restore?id=' + id, { source: 'elsewhere', file: 'x.es3' })).status, 400);
  assert.strictEqual((await call('POST', '/api/meta-restore', { source: 'game', file: '../x.bak' })).status, 400);
});

test('Duplicate: new slot, new name, same values, original backup', async () => {
  const src = await ok('GET', '/api/save?id=' + id);
  const r = await ok('POST', '/api/duplicate?id=' + id, { team: 'Test copy' });
  assert.ok(/^REPO_SAVE_\d{4}(_\d{2}){5}$/.test(r.id) && r.id !== id);
  const dup = await ok('GET', '/api/save?id=' + r.id);
  assert.strictEqual(dup.model.team, 'Test copy');
  assert.deepStrictEqual([dup.model.run, dup.model.players, dup.model.inv], [src.model.run, src.model.players, src.model.inv]);
  assert.ok((await ok('GET', '/api/backups?id=' + r.id)).some(b => b.reason === 'original'));
});

test('Comparing a backup returns the model of the backup', async () => {
  const list = await ok('GET', '/api/backups?id=' + id);
  const orig = list.find(b => b.reason === 'original');
  const m = await ok('GET', '/api/backup-model?id=' + id + '&source=editor&file=' + encodeURIComponent(orig.file));
  assert.ok(Object.values(m.model.upgradesPurchased).some(v => v > 0), 'the original should contain purchases');
});

test('Expert mode: read, write, refuse broken JSON and unknown formats', async () => {
  const raw = await ok('GET', '/api/raw?id=' + id);
  const json = JSON.parse(raw.text);
  dd(json).runStats.level = 42;
  await ok('POST', '/api/raw?id=' + id, { hash: raw.hash, text: JSON.stringify(json, null, 2) });
  assert.strictEqual(dd(files.read(file)).runStats.level, 42);
  const r2 = await ok('GET', '/api/raw?id=' + id);
  assert.strictEqual((await call('POST', '/api/raw?id=' + id, { hash: r2.hash, text: '{ broken' })).status, 400);
  assert.strictEqual((await call('POST', '/api/raw?id=' + id, { hash: r2.hash, text: '{"teamName":{}}' })).status, 400);
  assert.strictEqual((await call('POST', '/api/raw?id=' + id, { hash: r2.hash, text: '{"a":12345678901234567890}' })).status, 400);
  assert.strictEqual((await call('POST', '/api/raw?id=' + id, { hash: 'outdated', text: r2.text })).status, 409);
  assert.strictEqual(dd(files.read(file)).runStats.level, 42);
});

test('Expert mode keeps the structure of the save (values may change, sections may not go)', async () => {
  const raw = await ok('GET', '/api/raw?id=' + id);
  const bytes = fs.readFileSync(file);
  const tryWith = async change => {
    const json = JSON.parse(raw.text);
    change(json);
    return call('POST', '/api/raw?id=' + id, { hash: raw.hash, text: JSON.stringify(json) }, { 'X-REPO-Lang': 'en' });
  };
  const topKey = Object.keys(JSON.parse(raw.text)).find(k => k !== 'dictionaryOfDictionaries');
  let r = await tryWith(j => { delete j[topKey]; });
  assert.deepStrictEqual([r.status, r.data.error.startsWith('"' + topKey + '" is missing')], [400, true], r.data.error);
  r = await tryWith(j => { delete dd(j).runStats; });
  assert.deepStrictEqual([r.status, /dictionaryOfDictionaries\.runStats/.test(r.data.error)], [400, true], r.data.error);
  r = await tryWith(j => { j[topKey].__type = 'System.Object'; });
  assert.deepStrictEqual([r.status, /The type of/.test(r.data.error)], [400, true], r.data.error);
  assert.ok(fs.readFileSync(file).equals(bytes), 'nothing written');
});

test('Cosmetics: unlocking all changes only cosmeticUnlocks, order stays', async () => {
  const original = files.read(files.metaFile);
  const m = await ok('GET', '/api/meta');
  assert.deepStrictEqual(m.unlocks, original.cosmeticUnlocks.value);
  const all = Array.from({ length: COSMETICS }, (_, i) => i);
  const r = await ok('POST', '/api/meta', { hash: m.hash, unlocks: all });
  const written = files.read(files.metaFile);
  assert.deepStrictEqual(written.cosmeticUnlocks.value.slice(0, original.cosmeticUnlocks.value.length), original.cosmeticUnlocks.value);
  assert.strictEqual(r.unlocked, COSMETICS, 'only known cosmetics are counted');
  assert.ok(all.every(i => written.cosmeticUnlocks.value.includes(i)));
  written.cosmeticUnlocks = original.cosmeticUnlocks;
  assert.deepStrictEqual(written, original);
  assert.strictEqual((await call('POST', '/api/meta', { hash: 'outdated', unlocks: [] })).status, 409);
  assert.strictEqual((await call('POST', '/api/meta', { unlocks: [] })).status, 400);
});

test('Cosmetics: equipped and unknown IDs stay, invalid ones are dropped', async () => {
  const m = await ok('GET', '/api/meta');
  await ok('POST', '/api/meta', { hash: m.hash, unlocks: [-1, 9999, 'x'] });
  const unlocks = files.read(files.metaFile).cosmeticUnlocks.value;
  const unknown = m.unlocks.filter(i => i >= COSMETICS);
  if (files.synthetic) assert.deepStrictEqual(unknown, [UNKNOWN_UNLOCK]);
  const expected = [...new Set(m.equipped.concat(unknown))].sort((a, b) => a - b);
  assert.deepStrictEqual([...unlocks].sort((a, b) => a - b), expected);
});

test('Cosmetics: restore the original', async () => {
  const list = await ok('GET', '/api/meta-backups');
  const orig = list.find(b => b.reason === 'original');
  assert.ok(orig, 'original backup missing');
  const gameCopy = files.metaFile.replace(/\.es3$/i, '.bak'); // the game's own MetaSave.bak, if present
  assert.strictEqual(list.some(b => b.source === 'game'), fs.existsSync(gameCopy));
  await ok('POST', '/api/meta-restore', { source: 'editor', file: orig.file, hash: (await ok('GET', '/api/meta')).hash });
  const restored = files.read(files.metaFile).cosmeticUnlocks.value;
  assert.strictEqual(new Set(restored.filter(i => i < COSMETICS)).size, orig.unlocked);
  assert.ok(fs.readFileSync(files.metaFile).equals(fs.readFileSync(path.join(files.work, 'backups', 'MetaSave', orig.file))));
});

test('Cosmetics: with the built-in list after a game update nothing is locked', { skip: !files.synthetic && 'needs the synthetic game folder' }, async () => {
  // a newer Steam build than the one the built-in list was made for
  const manifest = path.join(files.gameDir, '..', '..', 'appmanifest_3241660.acf');
  fs.writeFileSync(manifest, '"AppState"\n{\n\t"buildid"\t\t"99999999"\n}\n');
  const updated = await startEditor(files);
  try {
    const st = await updated.ok('GET', '/api/state');
    assert.deepStrictEqual([st.cosmetics.source, st.cosmeticsLockable], ['builtin', false]);
    const m = await updated.ok('GET', '/api/meta');
    const r = await updated.ok('POST', '/api/meta', { hash: m.hash, unlocks: [] });
    assert.deepStrictEqual(files.read(files.metaFile).cosmeticUnlocks.value, m.unlocks, 'every unlock kept');
    assert.strictEqual(r.unlocked, new Set(m.unlocks.filter(i => i >= 0 && i < COSMETICS)).size);
  } finally {
    await updated.editor.close();
    fs.rmSync(manifest, { force: true });
  }
});

test('A save the game deleted is listed with its team name and comes back from a backup', async () => {
  const victim = (await ok('GET', '/api/saves')).find(s => s.id !== id && s.ok);
  const dir = path.join(files.savesDir, victim.id);
  const main = path.join(dir, victim.id + '.es3');
  const keep = fs.readFileSync(main);
  fs.rmSync(dir, { recursive: true, force: true }); // what R.E.P.O. does when the whole team dies
  try {
    const listed = (await ok('GET', '/api/deleted-saves')).find(d => d.id === victim.id);
    assert.ok(listed && listed.team === victim.team && listed.count > 0, JSON.stringify(listed));
    const all = await ok('GET', '/api/all-backups');
    const group = all.find(g => g.id === victim.id);
    assert.deepStrictEqual([group.exists, group.current, group.team], [false, null, victim.team]);
    const mine = all.find(g => g.id === id);
    assert.ok(mine.exists && mine.current.hash && mine.backups.length, 'existing saves are listed with their hash');
    const newest = group.backups.find(b => b.ok);
    assert.strictEqual((await call('POST', '/api/restore-deleted?id=' + victim.id, { file: '../x.es3' })).status, 400);
    const ownBackup = mine.backups.find(b => b.source === 'editor').file;
    assert.strictEqual((await call('POST', '/api/restore-deleted?id=' + id, { file: ownBackup })).status, 409, 'the save still exists');
    gameRunning = true;
    try {
      assert.strictEqual((await call('POST', '/api/restore-deleted?id=' + victim.id, { file: newest.file })).status, 409, 'game running');
    } finally {
      gameRunning = false;
    }
    await ok('POST', '/api/restore-deleted?id=' + victim.id, { file: newest.file });
    assert.ok(fs.readFileSync(main).equals(fs.readFileSync(path.join(files.work, 'backups', victim.id, newest.file))));
    assert.ok((await ok('GET', '/api/saves')).some(s => s.id === victim.id));
    assert.ok(!(await ok('GET', '/api/deleted-saves')).some(d => d.id === victim.id));
  } finally {
    if (!fs.existsSync(main)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(main, keep); }
  }
});

test('Profiles: save, clean up, read', async () => {
  const saved = await ok('POST', '/api/profiles', { profiles: [{ id: 'p1', name: 'Test', run: { currency: 5, evil: 1 }, upgrades: { playerUpgradeStamina: 3, __proto__x: 2 }, inv: { '<script>': 1, 'Item Melee Sword': 500 } }] });
  assert.deepStrictEqual(saved[0], { id: 'p1', name: 'Test', run: { currency: 5 }, upgrades: { playerUpgradeStamina: 3 }, inv: { 'Item Melee Sword': 99 } });
  assert.deepStrictEqual(await ok('GET', '/api/profiles'), saved);
  assert.strictEqual((await call('POST', '/api/profiles', { profiles: 'x' })).status, 400);
});

test('Settings: automatic backup and language are kept across restarts', async () => {
  assert.deepStrictEqual(state.settings, { autoBackup: true, language: null });
  assert.deepStrictEqual(await ok('POST', '/api/settings', { autoBackup: false, unknown: 1 }), { autoBackup: false, language: null });
  assert.deepStrictEqual(await ok('POST', '/api/settings', { autoBackup: 'no', language: 'fr' }), { autoBackup: false, language: null }, 'invalid: unchanged');
  assert.deepStrictEqual(await ok('POST', '/api/settings', { language: 'en' }), { autoBackup: false, language: 'en' });
  const second = await startEditor(files); // same data folder = the next start of the app
  try {
    assert.deepStrictEqual((await second.ok('GET', '/api/state')).settings, { autoBackup: false, language: 'en' });
  } finally {
    await second.editor.close();
  }
  await ok('POST', '/api/settings', { autoBackup: true, language: null });
});

test('A failed write (disk full) leaves the file and no temp file behind', async () => {
  const write = fs.writeSync;
  const settingsFile = path.join(files.work, 'data', 'settings.json');
  const settingsBefore = fs.readFileSync(settingsFile);
  fs.writeSync = () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
  try {
    const r = await call('POST', '/api/settings', { autoBackup: true }, { 'X-REPO-Lang': 'en' });
    assert.deepStrictEqual([r.status, r.data.error], [500, 'No free disk space left.']);
  } finally {
    fs.writeSync = write;
  }
  assert.ok(fs.readFileSync(settingsFile).equals(settingsBefore));
  assert.ok(!fs.readdirSync(path.join(files.work, 'data')).some(f => f.endsWith('.editor-tmp')));
});

test('Saving waits a moment while another program holds the file', async () => {
  // a virus scanner or OneDrive: the final rename fails a few times, then works
  const rename = fs.renameSync;
  let calls = 0;
  const lockedFor = n => (from, to) => {
    calls++;
    if (calls <= n) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return rename(from, to);
  };
  try {
    fs.renameSync = lockedFor(2);
    assert.deepStrictEqual(await ok('POST', '/api/settings', { autoBackup: true }), { autoBackup: true, language: null });
    assert.strictEqual(calls, 3);
    // held for good: a clear message, and no temp file is left behind
    calls = 0;
    fs.renameSync = lockedFor(Infinity);
    const r = await call('POST', '/api/settings', { autoBackup: true }, { 'X-REPO-Lang': 'en' });
    assert.deepStrictEqual([r.status, r.data.error], [500, 'The file is locked right now. Is R.E.P.O. still running?']);
    assert.ok(!fs.readdirSync(path.join(files.work, 'data')).some(f => f.endsWith('.editor-tmp')));
  } finally {
    fs.renameSync = rename;
  }
});

test('No game files, no password: a clear message instead of a crash', async () => {
  const blind = await startEditor(files, { gameDir: false });
  try {
    const st = await blind.ok('GET', '/api/state');
    assert.deepStrictEqual(st.password, { found: false, reason: 'noGame' });
    const list = await blind.ok('GET', '/api/saves');
    assert.ok(list.length && list.every(s => !s.ok && /password/i.test(s.error)), JSON.stringify(list[0]));
    const r = await blind.call('GET', '/api/save?id=' + id, undefined, { 'X-REPO-Lang': 'de' });
    assert.deepStrictEqual([r.status, /Passwort aus den Spieldateien/.test(r.data.error)], [422, true]);
  } finally {
    await blind.editor.close();
  }
});

test('Messages in the language of the page (X-REPO-Lang)', async () => {
  const ask = lang => call('GET', '/api/save?id=..', undefined, lang ? { 'X-REPO-Lang': lang } : {});
  assert.strictEqual((await ask('de')).data.error, 'Ungültige Spielstand-ID.');
  assert.strictEqual((await ask('en')).data.error, 'Invalid save ID.');
  assert.strictEqual((await ask('xx')).data.error, 'Invalid save ID.', 'unknown language: English');
  const s = await ok('GET', '/api/save?id=' + id);
  const conflict = await call('POST', '/api/save?id=' + id, { hash: 'old', model: s.model }, { 'X-REPO-Lang': 'de' });
  assert.deepStrictEqual([conflict.status, conflict.data.reason], [409, 'changed']);
  assert.ok(/vom Spiel verändert/.test(conflict.data.error));
  const denied = await call('GET', '/api/state', undefined, { 'X-REPO-Editor': 'wrong', 'X-REPO-Lang': 'de' });
  assert.deepStrictEqual([denied.status, denied.data.error], [403, 'Nicht erlaubt.']);
});

test('Refreshing the list backs up new saves', async () => {
  const id2 = 'REPO_SAVE_2030_01_01_00_00_00';
  fs.mkdirSync(path.join(files.savesDir, id2));
  fs.copyFileSync(file, path.join(files.savesDir, id2, id2 + '.es3'));
  const r = await ok('POST', '/api/rescan', {});
  assert.ok(r.made.includes(id2) && r.saves.some(s => s.id === id2) && r.savesDirExists && r.metaExists);
  assert.strictEqual((await ok('POST', '/api/rescan', {})).made.length, 0);
});

test('Opening folders only for known targets', async () => {
  await ok('POST', '/api/open?id=' + id, { what: 'backups' });
  await ok('POST', '/api/open', { what: 'saves' });
  assert.deepStrictEqual(opened, [path.join(files.work, 'backups', id), files.savesDir]);
  assert.strictEqual((await call('POST', '/api/open', { what: 'C:\\Windows' })).status, 400);
});

test('Page: CSP with script hash, no framing, no external addresses', async () => {
  const r = await call('GET', '/', undefined, {});
  // the page has exactly one inline script; found by plain search, independent of the server's helper
  assert.strictEqual(r.data.split('<script').length - 1, 1);
  const start = r.data.indexOf('<script>') + '<script>'.length;
  const script = r.data.slice(start, r.data.indexOf('</script>', start));
  const hash = crypto.createHash('sha256').update(script, 'utf8').digest('base64');
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp.includes("script-src 'sha256-" + hash + "'"), csp);
  assert.ok(/default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp));
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(!/(src|href)=["']?(https?:)?\/\//i.test(r.data), 'external resource in index.html');
});

test('Fonts are served locally, nothing else', async () => {
  const f = await call('GET', '/fonts/chakra-petch-latin-700-normal.woff2');
  assert.deepStrictEqual([f.status, f.type], [200, 'font/woff2']);
  assert.strictEqual((await call('GET', '/fonts/..%2Fserver.js')).status, 404);
  assert.strictEqual((await call('GET', '/package.json')).status, 404);
  assert.strictEqual((await call('GET', '/api/constructor')).status, 404);
});

test('No answer without a valid session token (reading too)', async () => {
  for (const token of [undefined, '', '1', editor.token.slice(1)]) {
    const headers = token === undefined ? {} : { 'X-REPO-Editor': token };
    assert.strictEqual(await rawRequest(port, 'GET', '/api/state', Object.assign({ Host: '127.0.0.1:' + port }, headers)), 403, 'GET ' + token);
    assert.strictEqual(await rawRequest(port, 'POST', '/api/backup?id=' + id, Object.assign({ Host: '127.0.0.1:' + port, 'Content-Type': 'application/json' }, headers)), 403, 'POST ' + token);
  }
});

test('Foreign host names, origins and sites are refused (DNS rebinding, CSRF)', async () => {
  const t = { 'X-REPO-Editor': editor.token };
  assert.strictEqual(await rawRequest(port, 'GET', '/api/state', Object.assign({ Host: 'evil.example:' + port }, t)), 403);
  assert.strictEqual(await rawRequest(port, 'GET', '/', { Host: 'evil.example' }), 403);
  assert.strictEqual(await rawRequest(port, 'POST', '/api/backup?id=' + id, Object.assign({ Host: '127.0.0.1:' + port, Origin: 'http://evil.example' }, t)), 403);
  assert.strictEqual(await rawRequest(port, 'POST', '/api/backup?id=' + id, Object.assign({ Host: '127.0.0.1:' + port, 'Sec-Fetch-Site': 'cross-site' }, t)), 403);
  assert.strictEqual(await rawRequest(port, 'GET', '/api/status', Object.assign({ Host: 'localhost:' + port }, t)), 200);
});

test('Oversized and broken requests are refused cleanly', async () => {
  const big = '{"profiles":"' + 'x'.repeat(5 * 1024 * 1024) + '"}';
  const t = { Host: '127.0.0.1:' + port, 'X-REPO-Editor': editor.token, 'Content-Type': 'application/json' };
  assert.strictEqual(await rawRequest(port, 'POST', '/api/profiles', t, big), 413);
  assert.strictEqual(await rawRequest(port, 'POST', '/api/profiles', t, '{broken'), 400);
  assert.strictEqual(await rawRequest(port, 'POST', '/api/profiles', t, '[1,2]'), 400);
  const { hash } = await ok('GET', '/api/save?id=' + id);
  assert.strictEqual((await call('POST', '/api/save?id=' + id, { hash, model: 'x' })).status, 400);
  // a request target Node accepts but URL parsing refuses: a clean 400, and the editor keeps running
  const answer = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end('GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n'));
    let data = '';
    socket.on('data', d => { data += d; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.ok(/^HTTP\/1\.1 400/.test(answer), answer.slice(0, 80));
  assert.strictEqual((await call('GET', '/api/status')).status, 200);
});

test('Error messages and the log show no user folder', async () => {
  const home = require('os').homedir();
  // a file where the backup folder of a save should be: the file system error names the path
  const id3 = 'REPO_SAVE_2031_01_01_00_00_00';
  const blocker = path.join(files.work, 'backups', id3);
  fs.mkdirSync(path.join(files.savesDir, id3));
  fs.copyFileSync(file, path.join(files.savesDir, id3, id3 + '.es3'));
  fs.writeFileSync(blocker, 'not a folder');
  try {
    const r = await call('GET', '/api/backups?id=' + id3);
    assert.strictEqual(r.status, 500);
    assert.ok(!r.data.error.toLowerCase().includes(home.toLowerCase()), r.data.error);
    if (blocker.toLowerCase().startsWith(home.toLowerCase())) assert.ok(r.data.error.includes('%USERPROFILE%'), r.data.error);
  } finally {
    fs.rmSync(blocker, { force: true });
    fs.rmSync(path.join(files.savesDir, id3), { recursive: true, force: true });
  }
  const cases = [
    [home + '\\x.es3', '%USERPROFILE%\\x.es3'],
    [home.toLowerCase().replace(/\\/g, '/') + '/y', '%USERPROFILE%/y'],
    ["open '" + home + "'", "open '%USERPROFILE%'"],
    [home + 'X\\z', home + 'X\\z'] // a different folder that only starts the same stays
  ];
  for (const [input, expected] of cases) assert.strictEqual(maskPaths(input), expected);
});

