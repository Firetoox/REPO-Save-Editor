'use strict';
// Unit tests of the library modules on synthetic data: node test/unit.js
// Needs neither the game nor real saves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');
const es3 = require('../lib/es3');
const { toModel, applyModel } = require('../lib/model');
const catalog = require('../lib/catalog');
const { loadCosmetics } = require('../lib/cosmetics');
const { parseSerializedFile } = require('../lib/unity');
const { loadCached } = require('../lib/cache');
const { readConfig, resolveOptions } = require('../lib/options');
const { createFixtures, fakeAssembly, fakeResources, P, UNKNOWN_UNLOCK, TEST_PASSWORD } = require('./fixtures');
const { readUserStrings, findPassword } = require('../lib/password');
const { test } = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-editor-unit-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const fixtures = createFixtures(path.join(tmp, 'fixtures'));
const files = es3.codec(TEST_PASSWORD);
const readJson = file => files.readSave(fs.readFileSync(file)).json;
const demoFile = path.join(fixtures.savesDir, fixtures.ids.demo, fixtures.ids.demo + '.es3');
const secondFile = path.join(fixtures.savesDir, fixtures.ids.second, fixtures.ids.second + '.es3');
const demo = () => readJson(demoFile);
const copy = o => JSON.parse(JSON.stringify(o));
const dd = json => json.dictionaryOfDictionaries.value;
/** applyModel on a copy of `json` after `edit(model)`; returns the new JSON. */
const edited = (json, edit) => { const m = toModel(json); edit(m); return applyModel(copy(json), m); };
const status = (fn, code) => assert.throws(fn, e => e.status === code, 'expected status ' + code);

// --- es3 ------------------------------------------------------------------------------------

// Known answer with the test password, cross-checked with .NET (Rfc2898DeriveBytes + Aes), the library Easy Save uses.
const KAT_IV = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const KAT_TEXT = '{"teamName":{"__type":"string","value":"KAT"}}';
const KAT_FILE = '000102030405060708090a0b0c0d0e0ffcb48f8698d7739e2043182054615bb5b3162f9e295658c783e89683350a5fc11ffce1878f9a19c17918939cbe8c6b45';

test('ES3: known answer encryption', () => {
  assert.strictEqual(files.encrypt(KAT_TEXT, { iv: KAT_IV }).toString('hex'), KAT_FILE);
  const dec = files.decrypt(Buffer.from(KAT_FILE, 'hex'));
  assert.deepStrictEqual([dec.text, dec.encrypted, dec.gzipped, dec.iv.toString('hex')], [KAT_TEXT, true, false, KAT_IV.toString('hex')]);
});

test('ES3: gzip, unencrypted and fresh IVs', () => {
  const gz = files.decrypt(files.encrypt(KAT_TEXT, { gzipped: true }));
  assert.deepStrictEqual([gz.text, gz.gzipped], [KAT_TEXT, true]);
  const plain = files.decrypt(Buffer.from(KAT_TEXT));
  assert.deepStrictEqual([plain.text, plain.encrypted], [KAT_TEXT, false]);
  // 32 bytes of plain JSON: looks like IV + one block, decryption fails, plain text wins
  const tricky = '{"a":"' + 'x'.repeat(24) + '"}';
  assert.strictEqual(files.decrypt(Buffer.from(tricky)).text, tricky);
  assert.notDeepStrictEqual(files.encrypt(KAT_TEXT).subarray(0, 16), files.encrypt(KAT_TEXT).subarray(0, 16));
});

test('ES3: damaged, foreign and oversized files', () => {
  const broken = Buffer.from(KAT_FILE, 'hex');
  broken[broken.length - 1] ^= 0xff;
  const code = c => err => err.code === c; // errors carry a translatable code
  assert.throws(() => files.decrypt(broken), code('es3.invalid.damaged'));
  assert.throws(() => files.decrypt(Buffer.from('not a save')), code('es3.invalid'));
  assert.throws(() => files.decrypt(Buffer.alloc(32 * 1024 * 1024 + 1)), code('file.tooLarge'));
  assert.throws(() => es3.decrypt(Buffer.from(KAT_FILE, 'hex'), null), code('es3.noPassword'));
  assert.throws(() => es3.decrypt(Buffer.from(KAT_FILE, 'hex'), 'wrong'), code('es3.invalid.damaged'));
  assert.throws(() => es3.encrypt(KAT_TEXT, {}), code('es3.noPassword'));
  // zip bomb: 70 MB of spaces packed into a few KB must not be unpacked completely
  const bomb = zlib.gzipSync(Buffer.alloc(70 * 1024 * 1024, 0x20));
  const cipher = crypto.createCipheriv('aes-128-cbc', crypto.pbkdf2Sync(TEST_PASSWORD, KAT_IV, 100, 16, 'sha1'), KAT_IV);
  assert.throws(() => files.decrypt(Buffer.concat([KAT_IV, cipher.update(bomb), cipher.final()])), code('es3.invalid.unpacked'));
});

test('ES3: a byte order mark is skipped, unreadable content is a clear 422', () => {
  const bom = files.readSave(Buffer.from('\uFEFF{"a":{"__type":"int","value":1}}', 'utf8'));
  assert.deepStrictEqual([bom.json.a.value, bom.encrypted], [1, false]);
  assert.throws(() => files.readSave(Buffer.from('{ broken')), e => e.status === 422 && e.code === 'es3.invalid.notJson');
  assert.throws(() => files.readSave(files.encrypt('{ broken')), e => e.status === 422 && e.code === 'es3.invalid.notJson');
});

test('ES3: numbers JavaScript cannot hold exactly are refused', () => {
  assert.deepStrictEqual(es3.parseJson('{"a":1,"b":-2.5,"c":"12345678901234567890","d":9007199254740991}'), { a: 1, b: -2.5, c: '12345678901234567890', d: 9007199254740991 });
  assert.deepStrictEqual(es3.parseJson('{"x\\"1":"y\\\\","n":[1e3]}'), { 'x"1': 'y\\', n: [1000] });
  for (const bad of ['{"a":12345678901234567}', '{"a":1e400}', '{"a":1.2e17}', '{"a":-9007199254740993}']) {
    assert.throws(() => es3.parseJson(bad), e => e.code === 'es3.unsafeNumber' && /without loss/.test(e.message), bad);
  }
});

// --- password from the game files -----------------------------------------------------------

test('Password: read the strings of a .NET file, find the right one with a probe', () => {
  const strings = readUserStrings(fakeAssembly(['a', 'Ünïcödé and emoji 🎮', 'x'.repeat(300), 'b']));
  assert.deepStrictEqual(strings.map(s => s.text), ['a', 'Ünïcödé and emoji 🎮', 'x'.repeat(300), 'b']);
  assert.ok(strings.every((s, i) => i === 0 || s.offset > strings[i - 1].offset));
  assert.throws(() => readUserStrings(Buffer.from('not a program')), /Not a readable/);
  assert.throws(() => readUserStrings(fakeAssembly(['a']).subarray(0, 300)), /Not a readable/);
  const cache = path.join(tmp, 'password-cache.json');
  const found = findPassword({ gameDir: fixtures.gameDir, files: [fixtures.metaFile, demoFile], cacheFile: cache });
  assert.strictEqual(found.password, TEST_PASSWORD);
  const cached = fs.readFileSync(cache, 'utf8');
  assert.ok(!cached.includes(TEST_PASSWORD) && /"offset":\d+/.test(cached), 'cache holds only the position');
  assert.strictEqual(findPassword({ gameDir: fixtures.gameDir, files: [demoFile], cacheFile: cache }).password, TEST_PASSWORD);
});

test('Password: a damaged probe file does not hide it', () => {
  // the smallest candidate is tried first; here it is garbage that only looks encrypted
  const damaged = path.join(tmp, 'damaged.es3');
  fs.writeFileSync(damaged, crypto.randomBytes(48));
  assert.strictEqual(findPassword({ gameDir: fixtures.gameDir, files: [damaged, demoFile] }).password, TEST_PASSWORD);
  assert.strictEqual(findPassword({ gameDir: fixtures.gameDir, files: [damaged] }).reason, 'notFound');
});

test('Password: reasons when it is not found', () => {
  assert.deepStrictEqual(findPassword({ gameDir: null, files: [demoFile] }), { password: null, reason: 'noGame' });
  assert.strictEqual(findPassword({ gameDir: tmp, files: [demoFile] }).reason, 'noDll');
  assert.strictEqual(findPassword({ gameDir: fixtures.gameDir, files: [] }).reason, 'noProbe');
  const plainFile = path.join(tmp, 'plain.es3');
  fs.writeFileSync(plainFile, '{"a":{"__type":"int","value":1}}');
  assert.strictEqual(findPassword({ gameDir: fixtures.gameDir, files: [plainFile] }).reason, 'noProbe', 'an unencrypted file is no probe');
  const other = path.join(tmp, 'other-game', 'REPO');
  fs.mkdirSync(path.join(other, 'REPO_Data', 'Managed'), { recursive: true });
  fs.writeFileSync(path.join(other, 'REPO_Data', 'Managed', 'Assembly-CSharp.dll'), fakeAssembly(['not the password', 'neither']));
  assert.strictEqual(findPassword({ gameDir: other, files: [demoFile] }).reason, 'notFound');
});

// --- model ----------------------------------------------------------------------------------

test('Model: a round trip without edits changes nothing', () => {
  for (const file of [demoFile, secondFile]) {
    const json = readJson(file);
    assert.deepStrictEqual(applyModel(copy(json), toModel(json)), json);
  }
});

test('Model: reads players, crown, HP, values and purchases', () => {
  const m = toModel(demo());
  assert.deepStrictEqual(m.players.map(p => [p.name, p.hp, p.crown]), [['Alex', 120, true], ['Sam', 85, false], ['Kim', 0, false]]);
  assert.strictEqual(m.run.level, 7);
  assert.ok(!('save level' in m.run), 'only known run values');
  assert.strictEqual(m.batteryLow, 2);
  assert.strictEqual(m.upgradesPurchased['Item Upgrade Player Energy'], 6);
  const ghost = toModel(readJson(secondFile)).players.find(p => p.id === P.ghost);
  assert.ok(ghost && ghost.name === P.ghost && ghost.hp === null, 'player without name and HP');
});

test('Model: writes only changes, explicit zeros stay', () => {
  const json = demo();
  const out = edited(json, m => { m.players[0].up.playerUpgradeStamina = 9; });
  assert.strictEqual(dd(out).playerUpgradeStamina[P.alex], 9);
  assert.strictEqual(dd(out).playerUpgradeThrow[P.sam], 0, 'explicit 0 stays');
  dd(out).playerUpgradeStamina[P.alex] = 3;
  assert.deepStrictEqual(out, json);
});

test('Model: HP 0 is allowed, values outside the limits stay untouched', () => {
  const json = demo();
  dd(json).runStats.lives = 500; // stored by a mod or a newer game, above the editor's limit
  let out = edited(json, m => { m.players[1].hp = 0; });
  assert.strictEqual(dd(out).playerHealth[P.sam], 0);
  assert.strictEqual(dd(out).runStats.lives, 500, 'untouched 500 stays');
  out = edited(json, m => { m.run.lives = 1000; m.run.currency = -5; });
  assert.deepStrictEqual([dd(out).runStats.lives, dd(out).runStats.currency], [99, 0]);
  status(() => applyModel(copy(json), Object.assign(toModel(json), { run: { level: 'x' } })), 400);
});

test('Model: inventory – remove, add, order, invalid names', () => {
  const json = demo();
  const order = Object.keys(dd(json).itemsPurchased);
  const out = edited(json, m => { delete m.inv['Item Gun Shotgun']; m.inv['Item Cart Medium'] = 0; m.inv['Item Melee Sword'] = 2; m.inv['Item Power Crystal'] = 5; });
  assert.deepStrictEqual(Object.keys(dd(out).itemsPurchased), order.filter(k => k !== 'Item Gun Shotgun' && k !== 'Item Cart Medium').concat('Item Melee Sword'));
  assert.strictEqual(dd(out).itemsPurchased['Item Power Crystal'], 5);
  status(() => edited(json, m => { m.inv['<img src=x>'] = 1; }), 400);
  status(() => edited(json, m => { m.inv['Item Gun Handgun'] = 'many'; }), 400);
});

test('Model: crown – move, only one, old multiple crowns stay untouched', () => {
  const json = demo();
  let out = edited(json, m => { m.players[0].crown = false; m.players[1].crown = true; });
  assert.deepStrictEqual(dd(out).playerHasCrown, { [P.sam]: 1 });
  status(() => edited(json, m => { m.players[1].crown = true; }), 400);
  const two = demo();
  dd(two).playerHasCrown = { [P.alex]: 1, [P.sam]: 1, '999': 1 };
  out = edited(two, m => { m.run.level = 8; });
  assert.deepStrictEqual(dd(out).playerHasCrown, dd(two).playerHasCrown, 'unchanged');
  out = edited(two, m => { m.players[1].crown = false; });
  assert.deepStrictEqual(dd(out).playerHasCrown, { '999': 1, [P.alex]: 1 }, 'non-player entry stays');
});

test('Model: team, batteries, upgrade purchases, unknown players', () => {
  const json = readJson(secondFile);
  dd(json).itemStatBattery = { a: 20, b: -1, c: 100 };
  const long = 'x'.repeat(80);
  const out = edited(json, m => {
    m.team = long;
    m.fillBatteries = true;
    m.upgradesPurchased = { 'Item Upgrade Player Health': 3 }; // not tracked in this save: ignored
    m.players.push({ id: '123', name: 'Stranger', hp: 50, crown: false, up: { playerUpgradeHealth: 5 } });
  });
  assert.strictEqual(out.teamName.value, 'x'.repeat(catalog.LIMITS.teamName));
  assert.strictEqual(out.teamNameChanged.value, true);
  assert.deepStrictEqual(dd(out).itemStatBattery, { a: 100, b: -1, c: 100 });
  assert.deepStrictEqual(dd(out).itemsUpgradesPurchased, {});
  assert.ok(!('123' in (dd(out).playerHealth || {})) && !('123' in dd(out).playerUpgradeHealth));
});

test('Model: keys like constructor and __proto__ from crafted files', () => {
  const json = readJson(secondFile);
  json.playerNames.value.constructor = 'C'; // must not pick up Object.prototype.constructor
  const m = toModel(json);
  const c = m.players.find(p => p.id === 'constructor');
  assert.deepStrictEqual([c.name, c.crown, c.hp, c.up.playerUpgradeHealth], ['C', false, null, 0]);
  assert.deepStrictEqual(applyModel(copy(json), m), json, 'stays writable and unchanged');
  const out = edited(json, mm => { mm.players.find(p => p.id === 'constructor').up.playerUpgradeHealth = 2; });
  assert.ok(Object.prototype.hasOwnProperty.call(dd(out).playerUpgradeHealth, 'constructor'));
  const proto = JSON.parse(JSON.stringify(json).replace('"itemsPurchased":{', '"itemsPurchased":{"__proto__":3,'));
  status(() => toModel(proto), 422);
  status(() => applyModel(proto, toModel(json)), 422);
  assert.strictEqual({}.polluted, undefined);
});

test('Model: unknown format is refused (422)', () => {
  status(() => toModel({}), 422);
  const json = demo();
  dd(json).playerHealth[P.alex] = '<b>120</b>';
  status(() => toModel(json), 422);
});

// --- catalog, cosmetics, unity ----------------------------------------------------------------

test('Catalog: built-in list', () => {
  const c = catalog.buildCatalog();
  const ids = new Set(c.categories.map(x => x.id));
  assert.strictEqual(c.source, 'builtin');
  assert.ok(c.items.length >= 55 && c.items.every(it => ids.has(it.cat) && it.max >= 1 && !it.disabled));
  assert.strictEqual(new Set(c.items.map(it => it.key)).size, c.items.length, 'no duplicate items');
  assert.strictEqual(c.items.find(it => it.key === 'Item Upgrade Map Player Count').max, 1);
  assert.strictEqual(c.upgrades.length, 13);
  assert.strictEqual(catalog.loadCatalog(null, null).source, 'builtin');
});

test('Catalog: scanned data is checked before use', () => {
  const scanned = catalog.ITEMS.map(([key, label]) => ({ key, label: label + '!', max: 2, disabled: false }));
  scanned.push({ key: 'Item Orb Test', label: 'Test Orb', max: 0, disabled: true }, { key: 42 }, null);
  const c = catalog.buildCatalog({ scanned });
  assert.strictEqual(c.source, 'game');
  assert.strictEqual(c.items.find(it => it.key === 'Item Gun Handgun').label, 'Gun!');
  assert.deepStrictEqual(c.items.find(it => it.key === 'Item Orb Test'), { key: 'Item Orb Test', label: 'Test Orb', cat: 'staff', max: 1, disabled: true });
  assert.strictEqual(catalog.buildCatalog({ scanned: scanned.slice(0, 5) }).source, 'builtin', 'too few hits');
  assert.strictEqual(catalog.categoryFor('Item Brand New'), 'other');
});

test('Catalog: item names and limits are read from the game files', () => {
  const game = path.join(tmp, 'scan-game');
  const assets = path.join(game, 'REPO_Data', 'resources.assets');
  fs.mkdirSync(path.dirname(assets), { recursive: true });
  // a limit of 100 or more is not plausible and is ignored
  const items = catalog.ITEMS.slice(0, 24).map(([key, label], i) => ({ key, label: label + ' (scan)', disabled: i === 3, max: i === 5 ? 150 : 1 + (i % 4) }));
  fs.writeFileSync(assets, fakeResources(items));
  assert.deepStrictEqual(catalog.scanGameItems(game), items.map(it => ({ key: it.key, label: it.label, disabled: it.disabled, max: it.max < 100 ? it.max : null })));
  const c = catalog.loadCatalog(game, path.join(tmp, 'scan-cache.json'));
  assert.strictEqual(c.source, 'game');
  assert.deepStrictEqual([items[0], items[3], items[5]].map(it => c.items.find(x => x.key === it.key)).map(x => [x.label, x.disabled]),
    [[items[0].label, false], [items[3].label, true], [items[5].label, false]]);
  // too few hits: the heuristic is not trusted and the built-in list stays
  fs.writeFileSync(assets, fakeResources(items.slice(0, 5)));
  assert.strictEqual(catalog.loadCatalog(game, path.join(tmp, 'scan-cache-few.json')).source, 'builtin');
});

test('Cosmetics: built-in list and fallback for a foreign game folder', () => {
  const c = loadCosmetics(null, null);
  assert.deepStrictEqual([c.source, c.list.length], ['builtin', 547]);
  assert.deepStrictEqual([0, 1, 2, 3].map(r => c.list.filter(x => x.rarity === r).length), [280, 131, 105, 31]);
  assert.strictEqual(c.list.filter(x => x.colorable === false).length, 73);
  assert.ok(c.list.every((x, i) => x.id === i && typeof x.name === 'string' && typeof x.type === 'string'));
  const fake = path.join(tmp, 'fake-game');
  fs.mkdirSync(path.join(fake, 'REPO_Data'), { recursive: true });
  for (const f of ['sharedassets0.assets', 'level0', 'globalgamemanagers.assets']) fs.writeFileSync(path.join(fake, 'REPO_Data', f), 'not Unity');
  const fb = loadCosmetics(fake, path.join(tmp, 'cos-cache.json'));
  assert.deepStrictEqual([fb.source, fb.list.length], ['builtin', 547]);
  assert.ok(fb.fallbackReason);
  assert.throws(() => parseSerializedFile(path.join(fake, 'REPO_Data', 'level0')));
});

test('Cache: reuse, scan again for a new stamp', () => {
  const file = path.join(tmp, 'cache.json');
  let scans = 0;
  const scan = () => ++scans;
  assert.strictEqual(loadCached(file, 'a', scan), 1);
  assert.strictEqual(loadCached(file, 'a', scan), 1);
  assert.strictEqual(loadCached(file, 'b', scan), 2);
  fs.writeFileSync(file, '{broken');
  assert.strictEqual(loadCached(file, 'b', scan), 3);
  assert.strictEqual(loadCached(null, 'b', scan), 4);
});

// --- options --------------------------------------------------------------------------------

test('Options: command line before environment before config.json before default', () => {
  const config = { savesDir: 'C:\\conf', backupDir: 'C:\\confB', gameDir: 'C:\\game' };
  const env = { REPO_SAVES_DIR: 'C:\\env', REPO_META_FILE: '  ' };
  const o = resolveOptions({ argv: ['--saves-dir', 'C:\\cli'], env, config, defaults: { backupDir: 'C:\\def' } });
  assert.deepStrictEqual([o.savesDir, o.metaFile, o.backupDir, o.gameDir, o.skipGameCheck, o.demoPaths], ['C:\\cli', undefined, 'C:\\confB', 'C:\\game', false, false]);
  assert.strictEqual(resolveOptions({ argv: [], env, config }).savesDir, 'C:\\env');
  assert.strictEqual(resolveOptions({ argv: ['--no-game'], env: {}, config }).gameDir, false);
  assert.strictEqual(resolveOptions({ argv: [], env: { REPO_EDITOR_NO_GAME: '1' }, config }).gameDir, false);
  assert.strictEqual(resolveOptions({ argv: ['--skip-game-check'], env: {} }).skipGameCheck, true);
  // port (server.js only): 0 means any free port, nothing given means the default
  const port = (argv, env2, conf) => resolveOptions({ argv, env: env2, config: conf }).port;
  assert.deepStrictEqual([port(['--port', '0'], {}), port([], { REPO_EDITOR_PORT: '5000' }), port([], {}, { port: 6000 }), port([], {})], [0, 5000, 6000, 4317]);
});

test('Options: a broken config.json is reported and ignored', () => {
  const messages = [];
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, '{ broken');
  assert.deepStrictEqual(readConfig(file, m => messages.push(m)), {});
  assert.strictEqual(messages.length, 1);
  fs.writeFileSync(file, '[1, 2]');
  assert.deepStrictEqual(readConfig(file), {});
  assert.deepStrictEqual(readConfig(path.join(tmp, 'missing.json'), m => messages.push(m)), {});
  assert.strictEqual(messages.length, 1, 'a missing file is normal');
});

test('Messages: German and English complete, same placeholders', () => {
  const { MESSAGES, message, appError, errorText } = require('../lib/messages');
  const keys = l => Object.keys(MESSAGES[l]).sort();
  assert.deepStrictEqual(keys('de'), keys('en'));
  const holes = text => (text.match(/\{\w+\}/g) || []).sort().join();
  for (const k of keys('de')) {
    assert.ok(MESSAGES.de[k].trim() && MESSAGES.en[k].trim(), 'empty: ' + k);
    assert.strictEqual(holes(MESSAGES.de[k]), holes(MESSAGES.en[k]), 'placeholders: ' + k);
  }
  assert.strictEqual(message('de', 'save.notFound', { id: 'X' }), 'Spielstand nicht gefunden: X');
  const e = appError(404, 'save.notFound', { id: 'X' });
  assert.deepStrictEqual([e.status, e.message, errorText(e, 'de')], [404, 'Save not found: X', 'Spielstand nicht gefunden: X']);
});

test('Page: inline scripts are found for their CSP hashes', () => {
  const { inlineScripts } = require('../lib/server');
  const html = '<p>x</p><script>let a = 1;</script><div></div><script>\nb();\n</script><script>unclosed';
  assert.deepStrictEqual(inlineScripts(html).map(s => s.text), ['let a = 1;', '\nb();\n']);
  assert.strictEqual(html.slice(inlineScripts(html)[1].start, inlineScripts(html)[1].start + 4), '\nb()');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.strictEqual(inlineScripts(page).length, 1, 'the page has exactly one inline script');
});

test('App: the window id equals build.appId (the installed app cannot read it from package.json)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes("app.setAppUserModelId('" + require('../package.json').build.appId + "')"));
});

// fixtures stay what the other tests expect
test('Test data: special cases present', () => {
  const meta = readJson(fixtures.metaFile);
  assert.ok(meta.cosmeticUnlocks.value.includes(UNKNOWN_UNLOCK));
  assert.ok(meta.cosmeticEquipped.value.includes(-1));
  assert.strictEqual(readJson(secondFile).teamNameChanged.value, false);
});

