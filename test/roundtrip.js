'use strict';
// Read-only checks of real or synthetic save files: node test/roundtrip.js [savesDir]
// Without an argument it runs on synthetic test saves (test/fixtures.js). With your own saves
// folder it only reads (also MetaSave.es3 next to it), never writes.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { test } = require('node:test');
const es3 = require('../lib/es3');
const { toModel, applyModel } = require('../lib/model');
const { createFixtures, TEST_PASSWORD } = require('./fixtures');
const { findGameDir } = require('../lib/catalog');
const { findPassword } = require('../lib/password');

let dir = process.argv[2];
let password = TEST_PASSWORD;
if (!dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-editor-roundtrip-'));
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  dir = createFixtures(tmp).savesDir;
} else {
  // real saves: the password comes from the installed game, as in the app
  const candidates = fs.readdirSync(dir).map(id => path.join(dir, id, id + '.es3')).filter(f => fs.existsSync(f));
  const found = findPassword({ gameDir: findGameDir(), files: candidates.concat(path.join(path.dirname(dir), 'MetaSave.es3')) });
  if (!found.password) { console.error('Password not found in the game files (' + found.reason + ').'); process.exit(2); }
  password = found.password;
}
const files = es3.codec(password);
const copy = o => JSON.parse(JSON.stringify(o));

/** The game's file can be reproduced byte for byte: same text + same IV = same file. */
function checkEncryption(file) {
  const buf = fs.readFileSync(file);
  const dec = files.decrypt(buf);
  assert.ok(dec.encrypted, path.basename(file) + ': not encrypted');
  const again = files.encrypt(dec.text, { iv: dec.iv, gzipped: dec.gzipped });
  assert.ok(again.equals(buf), path.basename(file) + ': encrypting again differs from the original');
  return dec;
}

const saveFiles = fs.readdirSync(dir)
  .filter(id => fs.statSync(path.join(dir, id)).isDirectory())
  .flatMap(id => fs.readdirSync(path.join(dir, id)).filter(f => f.endsWith('.es3')).map(f => path.join(dir, id, f)));

test('saves found in ' + dir, () => assert.ok(saveFiles.length > 0));

for (const file of saveFiles) {
  test(path.basename(file) + ': byte-identical encryption, lossless round trip, edits are kept', () => {
    const dec = checkEncryption(file);
    const json = es3.parseJson(dec.text);

    // A round trip through the model without edits changes nothing.
    assert.deepStrictEqual(applyModel(copy(json), toModel(json)), json, 'a round trip without edits changes data');

    // Edits survive encrypt -> decrypt.
    const m = toModel(json);
    m.team = 'Test-Team';
    m.run.currency = 4242;
    m.run.lives = 7;
    if (m.players[0]) { m.players[0].up.playerUpgradeStamina = 9; m.players.forEach((p, i) => { p.crown = i === 0; }); }
    m.inv['Item Melee Sword'] = 1;
    delete m.inv['Item Power Crystal'];
    m.fillBatteries = true;
    const out = files.writeSave(applyModel(copy(json), m), { gzipped: dec.gzipped });
    const back = toModel(files.readSave(out).json);
    assert.strictEqual(back.team, 'Test-Team');
    assert.deepStrictEqual([back.run.currency, back.run.lives], [4242, 7]);
    if (m.players[0]) { assert.strictEqual(back.players[0].up.playerUpgradeStamina, 9); assert.ok(back.players[0].crown); }
    assert.strictEqual(back.inv['Item Melee Sword'], 1);
    assert.ok(!('Item Power Crystal' in back.inv));
    assert.strictEqual(back.batteryLow, 0);
  });
}

// MetaSave (cosmetics) next to the saves folder
for (const name of ['MetaSave.es3', 'MetaSave.bak']) {
  const file = path.join(path.dirname(dir), name);
  if (!fs.existsSync(file)) continue;
  test(name + ': byte-identical encryption, cosmetic unlocks readable', () => {
    const json = es3.parseJson(checkEncryption(file).text);
    assert.ok(Array.isArray(json.cosmeticUnlocks.value), 'cosmeticUnlocks missing');
  });
}
