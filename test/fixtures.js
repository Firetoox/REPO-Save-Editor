'use strict';
// Synthetic R.E.P.O. files for tests and screenshots: same structure and types as the game's files,
// but invented content (no real players, Steam IDs or team names) and fixed file times, so nothing
// in tests or screenshots depends on when or where they were made.
// Edge cases on purpose: explicit zeros, a dead player (0 HP), a player without a name (only in an
// upgrade dictionary), teamNameChanged = false, an empty equip slot (-1) and an unlock id the
// editor does not know (600, as if from a newer game version).
// Encrypted with an invented test password; a fake game folder (<folder>/game/REPO) holds it the way
// the real game does, so the editor finds it through its normal password search.
// CLI: node test/fixtures.js <folder>   -> <folder>/saves/..., MetaSave.es3, MetaSave.bak, game/REPO

const fs = require('fs');
const path = require('path');
const es3 = require('../lib/es3');

const NET = ', mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089';
const T_STR = 'System.String' + NET;
const T_INT = 'System.Int32' + NET;
const DICT_STR_STR = 'System.Collections.Generic.Dictionary`2[[' + T_STR + '],[' + T_STR + ']],mscorlib';
const DICT_STR_INT = 'System.Collections.Generic.Dictionary`2[[' + T_STR + '],[' + T_INT + ']]' + NET;
const DICT_OF_DICTS = 'System.Collections.Generic.Dictionary`2[[' + T_STR + '],[' + DICT_STR_INT + ']],mscorlib';
const LIST_INT = 'System.Collections.Generic.List`1[[' + T_INT + ']],mscorlib';
const LIST_LIST_INT = 'System.Collections.Generic.List`1[[System.Collections.Generic.List`1[[' + T_INT + ']]' + NET + ']],mscorlib';
const INT_ARRAY = 'System.Int32[],mscorlib';

// Obviously fake Steam IDs (real ones start with 7656119...).
const P = { alex: '10000000000000001', sam: '10000000000000002', kim: '10000000000000003', robin: '10000000000000004', jo: '10000000000000005', ghost: '10000000000000009' };
const UNKNOWN_UNLOCK = 600;
const EMPTY_SLOT = -1;

function save({ team, teamChanged = true, date, timePlayed, players, run, inv, items, battery, bought, boughtTotal, crown, health, up }) {
  const dd = {
    item: items,
    itemBatteryUpgrades: {},
    itemsPurchased: inv,
    itemsPurchasedTotal: boughtTotal,
    itemStatBattery: battery,
    itemsUpgradesPurchased: bought,
    playerHasCrown: crown,
    playerHealth: health
  };
  const fields = ['CrouchRest', 'DeathHeadBattery', 'ExtraJump', 'Health', 'Launch', 'MapPlayerCount', 'Range', 'Speed', 'Stamina', 'Strength', 'Throw', 'TumbleClimb', 'TumbleWings'];
  for (const f of fields) dd['playerUpgrade' + f] = up[f] || {};
  dd.runStats = Object.assign({}, run, { 'save level': 1 });
  return {
    teamName: { __type: 'string', value: team },
    teamNameChanged: { __type: 'bool', value: teamChanged },
    dateAndTime: { __type: 'string', value: date },
    timePlayed: { __type: 'float', value: timePlayed },
    playerNames: { __type: DICT_STR_STR, value: players },
    dictionaryOfDictionaries: { __type: DICT_OF_DICTS, value: dd },
    saveVersion: { __type: 'int', value: 1 }
  };
}

function demoCrew(level, currency) {
  return save({
    team: 'Demo Crew',
    date: '2026-01-15',
    timePlayed: 9876.5,
    players: { [P.alex]: 'Alex', [P.sam]: 'Sam', [P.kim]: 'Kim' },
    run: { level, currency, lives: 3, chargingStationCharge: 4, chargingStationChargeTotal: 30, totalHaul: 812 },
    inv: { 'Item Power Crystal': 4, 'Item Cart Medium': 2, 'Item Gun Handgun': 1, 'Item Gun Shotgun': 1, 'Item Melee Frying Pan': 1, 'Item Health Pack Medium': 2 },
    items: { 'Item Cart Medium/1': 2, 'Item Cart Medium/2': 2, 'Item Gun Handgun/1': 16, 'Item Gun Shotgun/1': 19, 'Item Melee Frying Pan/1': 27, 'Item Upgrade Player Health/1': 50, 'Item Upgrade Player Energy/1': 46, 'Item WalkieTalkie/1': -1 },
    battery: { 'Item Gun Handgun/1': 60, 'Item Gun Shotgun/1': 40, 'Item Melee Frying Pan/1': 100 },
    bought: { 'Item Upgrade Player Health': 4, 'Item Upgrade Player Energy': 6, 'Item Upgrade Player Grab Strength': 3, 'Item Upgrade Player Sprint Speed': 2 },
    boughtTotal: { 'Item Power Crystal': 9, 'Item Cart Medium': 2, 'Item Gun Handgun': 1, 'Item Gun Shotgun': 1, 'Item Melee Frying Pan': 1, 'Item Health Pack Medium': 5, 'Item Upgrade Player Health': 4, 'Item Upgrade Player Energy': 6, 'Item Upgrade Player Grab Strength': 3, 'Item Upgrade Player Sprint Speed': 2 },
    crown: { [P.alex]: 1 },
    health: { [P.alex]: 120, [P.sam]: 85, [P.kim]: 0 }, // Kim is dead: the game stores 0 HP
    up: {
      Health: { [P.alex]: 2, [P.sam]: 1 },
      Stamina: { [P.alex]: 3, [P.sam]: 2, [P.kim]: 1 },
      Strength: { [P.alex]: 2, [P.kim]: 1 },
      Speed: { [P.sam]: 2 },
      Range: { [P.alex]: 1 },
      CrouchRest: { [P.kim]: 1 },
      Throw: { [P.alex]: 1, [P.sam]: 0 } // the game sometimes keeps explicit zeros
    }
  });
}

function secondRun() {
  return save({
    team: 'Second Run',
    teamChanged: false,
    date: '2026-01-10',
    timePlayed: 2400,
    players: { [P.robin]: 'Robin', [P.jo]: 'Jo' },
    run: { level: 2, currency: 35, lives: 3, chargingStationCharge: 1, chargingStationChargeTotal: 6, totalHaul: 120 },
    inv: { 'Item Power Crystal': 1, 'Item Cart Medium': 1 },
    items: { 'Item Cart Medium/1': 2 },
    battery: {},
    bought: {},
    boughtTotal: { 'Item Power Crystal': 1, 'Item Cart Medium': 1 },
    crown: {},
    health: { [P.robin]: 100, [P.jo]: 100 },
    up: { Stamina: { [P.robin]: 1 }, Speed: { [P.ghost]: 1 } } // ghost: no name stored, only an upgrade
  });
}

function metaSave(unlocks, equipped) {
  const colors = Array.from({ length: 33 }, (_, i) => (i % 5 === 0 ? 2 : 7));
  return {
    colorsEquipped: { __type: INT_ARRAY, value: colors },
    colorPresets: { __type: LIST_LIST_INT, value: [colors, colors.map(() => 0), colors.map(() => 2)] },
    cosmeticPresets: { __type: LIST_LIST_INT, value: [[], [], equipped.slice(0, 2)] },
    cosmeticEquipped: { __type: LIST_INT, value: equipped },
    cosmeticHistory: { __type: LIST_INT, value: unlocks.slice() },
    cosmeticUnlocks: { __type: LIST_INT, value: unlocks },
    cosmeticTokens: { __type: LIST_INT, value: [] }
  };
}

/** Local time as file time in seconds, so the dates shown match the save names. */
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;

// The test files are encrypted with an invented password, not the game's. The fake game folder
// below carries it in a fake Assembly-CSharp.dll, so tests go through the real password search.
const TEST_PASSWORD = 'Invented password of the REPO Save Editor test files';
const files = es3.codec(TEST_PASSWORD);

function write(file, json, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, files.writeSave(json, {}));
  fs.utimesSync(file, mtime, mtime);
}

/**
 * A minimal .NET assembly: PE headers, CLI header, metadata root and one "#US" heap holding
 * `strings` (the layout lib/password.js reads, see ECMA-335).
 */
function fakeAssembly(strings) {
  const heap = [Buffer.from([0])]; // entry 0: the empty string
  for (const s of strings) {
    const text = Buffer.from(s, 'utf16le');
    const len = text.length + 1; // + trailing flag byte
    const head = len < 0x80 ? Buffer.from([len]) : Buffer.from([0x80 | (len >> 8), len & 0xff]);
    heap.push(head, text, Buffer.from([0]));
  }
  let us = Buffer.concat(heap);
  us = Buffer.concat([us, Buffer.alloc((4 - us.length % 4) % 4)]);

  const SECTION_RVA = 0x2000, SECTION_FILE = 0x200, CLI_SIZE = 72;
  const version = Buffer.from('v4.0.30319\0\0'); // length padded to 4
  const root = Buffer.alloc(16 + version.length + 4 + 12);
  root.writeUInt32LE(0x424a5342, 0); // "BSJB"
  root.writeUInt16LE(1, 4); root.writeUInt16LE(1, 6);
  root.writeUInt32LE(version.length, 12);
  version.copy(root, 16);
  const p = 16 + version.length;
  root.writeUInt16LE(0, p); root.writeUInt16LE(1, p + 2); // flags, 1 stream
  root.writeUInt32LE(root.length, p + 4); // #US directly after the root
  root.writeUInt32LE(us.length, p + 8);
  Buffer.from('#US\0').copy(root, p + 12);
  const cli = Buffer.alloc(CLI_SIZE);
  cli.writeUInt32LE(CLI_SIZE, 0);
  cli.writeUInt32LE(SECTION_RVA + CLI_SIZE, 8); // metadata right after the CLI header
  cli.writeUInt32LE(root.length + us.length, 12);
  const section = Buffer.concat([cli, root, us]);

  const head = Buffer.alloc(SECTION_FILE);
  head.write('MZ', 0, 'ascii');
  head.writeUInt32LE(0x80, 0x3c);
  head.writeUInt32LE(0x00004550, 0x80); // "PE\0\0"
  const coff = 0x84, optional = coff + 20, OPTIONAL_SIZE = 224;
  head.writeUInt16LE(0x14c, coff); head.writeUInt16LE(1, coff + 2); head.writeUInt16LE(OPTIONAL_SIZE, coff + 16);
  head.writeUInt16LE(0x10b, optional); // PE32
  head.writeUInt32LE(SECTION_RVA, optional + 96 + 14 * 8); // CLI header directory
  head.writeUInt32LE(CLI_SIZE, optional + 96 + 14 * 8 + 4);
  const table = optional + OPTIONAL_SIZE;
  head.write('.text', table, 'ascii');
  head.writeUInt32LE(section.length, table + 8); head.writeUInt32LE(SECTION_RVA, table + 12);
  head.writeUInt32LE(section.length, table + 16); head.writeUInt32LE(SECTION_FILE, table + 20);
  return Buffer.concat([head, section]);
}

/**
 * A tiny stand-in for the game's resources.assets with Item records in the layout lib/catalog.js
 * scans for (see scanGameItems), separated by unrelated bytes, plus decoys that only look similar.
 * `newer`: the layout since build 26294889 (status before `disabled`, bool cachedFinalized after
 * the prefab path).
 * @param {{ key: string, label: string, disabled?: boolean, wip?: boolean, max: number, prefab?: string }[]} items
 * @param {{ newer?: boolean }} [opts]
 */
function fakeResources(items, { newer = false } = {}) {
  const str = s => {
    const text = Buffer.from(s, 'utf8');
    const out = Buffer.alloc(4 + text.length + (4 - text.length % 4) % 4); // length, text, padding
    out.writeInt32LE(text.length, 0);
    text.copy(out, 4);
    return out;
  };
  const int = v => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; };
  const filler = n => Buffer.alloc(n, 0x5a);
  const parts = [filler(64), str('Item text in a dialog'), int(7), filler(32), Buffer.from('Item without a length prefix')];
  const pptr = (fileID, pathID) => { const b = Buffer.alloc(12); b.writeInt32LE(fileID, 0); b.writeBigInt64LE(BigInt(pathID), 4); return b; };
  items.forEach((it, i) => {
    parts.push(
      str(it.key), ...(newer ? [int(it.wip ? 0 : 1)] : []), int(it.disabled ? 1 : 0), str(it.label),
      filler(24), // other fields of the asset
      str(it.key), str(it.prefab || 'Items/' + it.key), // PrefabRef: prefab name and path
      pptr(0, 0), ...(newer ? [int(it.wip ? 0 : 1)] : []), // bundle, cachedFinalized
      pptr(i % 3, 14000 + i), // price asset
      int(it.max),
      filler(40)
    );
  });
  return Buffer.concat(parts);
}

/** A fake R.E.P.O. folder: just enough for the editor to find it and read the password. */
function fakeGame(dir) {
  const data = path.join(dir, 'REPO_Data');
  fs.mkdirSync(path.join(data, 'Managed'), { recursive: true });
  fs.writeFileSync(path.join(data, 'resources.assets'), 'not a Unity file'); // item list: built-in fallback
  const decoys = ['Item Gun Handgun', 'saves', 'Player', 'This is a longer message with words in it.'];
  fs.writeFileSync(path.join(data, 'Managed', 'Assembly-CSharp.dll'), fakeAssembly(decoys.slice(0, 2).concat(TEST_PASSWORD, decoys.slice(2))));
  return dir;
}

/**
 * Writes the test files into `dir`.
 * @returns {{ savesDir: string, metaFile: string, gameDir: string, ids: { demo: string, second: string } }}
 */
function createFixtures(dir) {
  const savesDir = path.join(dir, 'saves');
  const a = 'REPO_SAVE_2026_01_15_20_00_00', b = 'REPO_SAVE_2026_01_10_18_30_00';
  write(path.join(savesDir, a, a + '_BACKUP1.es3'), demoCrew(5, 40), at(2026, 1, 13, 21, 10));
  write(path.join(savesDir, a, a + '_BACKUP2.es3'), demoCrew(6, 120), at(2026, 1, 14, 22, 40));
  write(path.join(savesDir, a, a + '.es3'), demoCrew(7, 250), at(2026, 1, 15, 23, 5));
  write(path.join(savesDir, b, b + '.es3'), secondRun(), at(2026, 1, 10, 19, 45));
  const unlocks = Array.from({ length: 40 }, (_, i) => i).concat([84, 265, 419, 432, 546, UNKNOWN_UNLOCK]);
  const metaFile = path.join(dir, 'MetaSave.es3');
  write(metaFile, metaSave(unlocks, [0, 2, 84, 419, EMPTY_SLOT]), at(2026, 1, 15, 23, 5));
  write(path.join(dir, 'MetaSave.bak'), metaSave(unlocks.slice(0, 30), [0, 2, EMPTY_SLOT]), at(2026, 1, 14, 22, 40));
  const gameDir = fakeGame(path.join(dir, 'game', 'REPO'));
  return { savesDir, metaFile, gameDir, ids: { demo: a, second: b } };
}

module.exports = { createFixtures, fakeAssembly, fakeResources, P, UNKNOWN_UNLOCK, TEST_PASSWORD };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('node test/fixtures.js <folder>'); process.exit(2); }
  const r = createFixtures(path.resolve(dir));
  console.log('Test data written: ' + r.savesDir + ', ' + r.metaFile + ', game folder ' + r.gameDir);
}
