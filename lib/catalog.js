'use strict';
// Items, upgrades, run values and limits. The built-in item list was read from the game's own item
// definitions (REPO_Data/resources.assets); scanGameItems() refreshes names and limits from the
// installed game, so game updates are picked up without a new editor version.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadCached } = require('./cache');
const { align4, PPTR_SIZE } = require('./unity');

/** Limits for values the editor writes (one source of truth, also sent to the UI). */
const LIMITS = { teamName: 60, profileName: 60, hp: 9999, upgradeLevel: 999, itemCount: 99, purchases: 999 };

/** Item categories; labels in both UI languages. */
const CATEGORIES = [
  { id: 'gun', label: { de: 'Schusswaffen', en: 'Guns' }, color: '#FF9B6A' },
  { id: 'melee', label: { de: 'Nahkampf', en: 'Melee' }, color: '#E8C468' },
  { id: 'grenade', label: { de: 'Granaten & Wurfobjekte', en: 'Grenades & throwables' }, color: '#F07A8A' },
  { id: 'mine', label: { de: 'Minen', en: 'Mines' }, color: '#FF7FBF' },
  { id: 'drone', label: { de: 'Drohnen', en: 'Drones' }, color: '#6FB8FF' },
  { id: 'staff', label: { de: 'Stäbe & Orbs', en: 'Staffs & orbs' }, color: '#B28CFF' },
  { id: 'heal', label: { de: 'Heilung', en: 'Healing' }, color: '#5FD1A8' },
  { id: 'gear', label: { de: 'Ausrüstung', en: 'Gear' }, color: '#A9B6C4' },
  { id: 'vehicle', label: { de: 'Fahrzeuge', en: 'Vehicles' }, color: '#D9A27A' },
  { id: 'upgrade', label: { de: 'Upgrade-Items', en: 'Upgrade items' }, color: '#7FD4E8' },
  { id: 'other', label: { de: 'Sonstige', en: 'Other' }, color: '#8A9099' }
];

/** Item.status in the game: the developers mark unfinished items as WIP, the shop never sells them. */
const WIP = 'wip';

// [internal key, name shown in game, category, maxAmount from the game's item definition (build TESTED_BUILD in lib/server.js), WIP]
const ITEMS = [
  ['Item Gun Handgun', 'Gun', 'gun', 1],
  ['Item Gun Shotgun', 'Shotgun', 'gun', 1],
  ['Item Gun Tranq', 'Tranq Gun', 'gun', 1],
  ['Item Gun Stun', 'Boltzap', 'gun', 1],
  ['Item Gun Laser', 'Photon Blaster', 'gun', 1],
  ['Item Gun Shockwave', 'Pulse Pistol', 'gun', 1],
  ['Item Gun Revolver', 'Human Gun', 'gun', 1, WIP],
  ['Item Cart Cannon', 'C.A.R.T. Cannon', 'gun', 1],
  ['Item Cart Laser', 'C.A.R.T. Laser', 'gun', 1],
  ['Item Melee Baseball Bat', 'Baseball Bat', 'melee', 1],
  ['Item Melee Frying Pan', 'Frying Pan', 'melee', 1],
  ['Item Melee Inflatable Hammer', 'Inflatable Hammer', 'melee', 1],
  ['Item Melee Sledge Hammer', 'Sledge Hammer', 'melee', 1],
  ['Item Melee Stun Baton', 'Prodzap', 'melee', 1],
  ['Item Melee Sword', 'Sword', 'melee', 1],
  ['Item Melee Whip', 'Human Adventure Cable', 'melee', 1],
  ['Item Grenade Explosive', 'Grenade', 'grenade', 3],
  ['Item Grenade Duct Taped', 'Duct Taped Grenades', 'grenade', 3],
  ['Item Grenade Human', 'Human Grenade', 'grenade', 3],
  ['Item Grenade Shockwave', 'Shockwave Grenade', 'grenade', 3],
  ['Item Grenade Stun', 'Stun Grenade', 'grenade', 3],
  ['Item Rubber Duck', 'Rubber Duck', 'grenade', 1],
  ['Item Mine Explosive', 'Explosive Mine', 'mine', 3],
  ['Item Mine Shockwave', 'Shockwave Mine', 'mine', 3],
  ['Item Mine Stun', 'Trapzap', 'mine', 3],
  ['Item Drone Battery', 'Recharge Drone', 'drone', 1],
  ['Item Drone Feather', 'Feather Drone', 'drone', 1],
  ['Item Drone Indestructible', 'Indestructible Drone', 'drone', 1],
  ['Item Drone Torque', 'Roll Drone', 'drone', 1],
  ['Item Drone Zero Gravity', 'Zero Gravity Drone', 'drone', 1],
  ['Item Staff Torque', 'Roll Staff', 'staff', 1],
  ['Item Staff Void', 'Void Staff', 'staff', 1],
  ['Item Staff Zero Gravity', 'Zero Gravity Staff', 'staff', 1],
  ['Item Orb Zero Gravity', 'Zero Gravity Orb', 'staff', 1],
  ['Item Orb Battery', 'Recharge Orb', 'staff', 1, WIP],
  ['Item Health Pack Small', 'Small Health Pack (25)', 'heal', 3],
  ['Item Health Pack Medium', 'Medium Health Pack (50)', 'heal', 3],
  ['Item Health Pack Large', 'Large Health Pack (100)', 'heal', 3],
  ['Item ReviveItem', 'Defibro', 'heal', 1],
  ['Item Cart Medium', 'C.A.R.T.', 'gear', 4],
  ['Item Cart Small', 'POCKET C.A.R.T.', 'gear', 2],
  ['Item Power Crystal', 'Energy Crystal', 'gear', 10],
  ['Item Valuable Tracker', 'Valuable Tracker', 'gear', 1],
  ['Item Extraction Tracker', 'Extraction Tracker', 'gear', 1],
  ['Item Phase Bridge', 'Phase Bridge', 'gear', 1],
  ['Item Duck Bucket', 'Duck Bucket', 'gear', 1],
  ['Item Leaf Blower', 'Leaf Blower', 'gear', 1],
  ['Item WalkieTalkieBox', 'Semibot Walkies', 'gear', 2],
  ['Item WalkieTalkie', 'Semibot Walkie', 'gear', 1, WIP],
  ['Item Vehicle Semiscooter', 'Hauler', 'vehicle', 1],
  ['Item Vehicle Semiscooter Small', 'Scout', 'vehicle', 2],
  ['Item Upgrade Player Health', 'Health Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Energy', 'Stamina Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Extra Jump', 'Extra Jump Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Tumble Launch', 'Tumble Launch Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Grab Range', 'Range Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Grab Strength', 'Strength Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Sprint Speed', 'Sprint Speed Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Crouch Rest', 'Crouch Rest Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Tumble Wings', 'Tumble Wings Upgrade', 'upgrade', 10],
  ['Item Upgrade Player Tumble Climb', 'Tumble Climb Upgrade', 'upgrade', 10],
  ['Item Upgrade Death Head Battery', 'Death Head Battery Upgrade', 'upgrade', 10],
  ['Item Upgrade Map Player Count', 'Map Player Count Upgrade', 'upgrade', 1]
];

/**
 * Per-player upgrade dictionaries in the save. `name` is the in-game name (the game is English only);
 * `hint` explains it in other UI languages.
 */
const UPGRADES = [
  { field: 'playerUpgradeHealth', name: 'Health', hint: { de: 'Gesundheit' } },
  { field: 'playerUpgradeStamina', name: 'Stamina', hint: { de: 'Ausdauer' } },
  { field: 'playerUpgradeExtraJump', name: 'Extra Jump', hint: { de: 'Extra-Sprung' } },
  { field: 'playerUpgradeLaunch', name: 'Tumble Launch', hint: { de: 'Tumble-Absprung' } },
  { field: 'playerUpgradeRange', name: 'Range', hint: { de: 'Greifweite' } },
  { field: 'playerUpgradeStrength', name: 'Strength', hint: { de: 'Greifkraft' } },
  { field: 'playerUpgradeThrow', name: 'Throw', hint: { de: 'Wurfkraft' } },
  { field: 'playerUpgradeSpeed', name: 'Sprint Speed', hint: { de: 'Sprinttempo' } },
  { field: 'playerUpgradeCrouchRest', name: 'Crouch Rest', hint: { de: 'Erholung beim Ducken' } },
  { field: 'playerUpgradeTumbleWings', name: 'Tumble Wings', hint: { de: 'Gleitflügel' } },
  { field: 'playerUpgradeTumbleClimb', name: 'Tumble Climb', hint: { de: 'Klettern im Tumble' } },
  { field: 'playerUpgradeDeathHeadBattery', name: 'Death Head Battery', hint: { de: 'Kopf-Akku nach dem Tod' } },
  { field: 'playerUpgradeMapPlayerCount', name: 'Map Player Count', hint: { de: 'Spieler auf der Karte' } }
];

/**
 * Editable values in dictionaryOfDictionaries.runStats.
 * key: name in the save · label/hint: shown in the UI, per language · suffix: unit after the number
 * chips: quick-add amounts for the UI. Level 0 is valid (a run before the first level is finished).
 */
const RUN_FIELDS = [
  { key: 'level', label: { de: 'Level', en: 'Level' }, hint: { de: 'Aktuelles Level des Runs', en: 'Current level of the run' }, min: 0, max: 999, step: 1 },
  { key: 'currency', label: { de: 'Geld', en: 'Money' }, hint: { de: 'in Tausend $ (K)', en: 'in thousands of $ (K)' }, min: 0, max: 9999999, step: 10, suffix: ' K', chips: [100, 1000, 10000] },
  { key: 'lives', label: { de: 'Leben', en: 'Lives' }, hint: { de: 'Leben im Run', en: 'Lives in the run' }, min: 0, max: 99, step: 1 },
  { key: 'chargingStationCharge', label: { de: 'Ladestation', en: 'Charging station' }, hint: { de: 'Aktuelle Ladungen', en: 'Current charges' }, min: 0, max: 999, step: 1 },
  { key: 'chargingStationChargeTotal', label: { de: 'Ladestation gesamt', en: 'Charging station total' }, hint: { de: 'Ladungen insgesamt', en: 'Total charges' }, min: 0, max: 9999, step: 1 },
  { key: 'totalHaul', label: { de: 'Gesamtbeute', en: 'Total haul' }, hint: { de: 'in Tausend $ (K)', en: 'in thousands of $ (K)' }, min: 0, max: 99999999, step: 10, suffix: ' K' }
];

/** Category for items that only exist in a newer game version (not in ITEMS). */
function categoryFor(key) {
  const rules = [
    [/^Item (Gun |Cart Cannon|Cart Laser)/, 'gun'],
    [/^Item Melee /, 'melee'],
    [/^Item (Grenade |Rubber Duck)/, 'grenade'],
    [/^Item Mine /, 'mine'],
    [/^Item Drone /, 'drone'],
    [/^Item (Staff |Orb )/, 'staff'],
    [/^Item (Health Pack|ReviveItem)/, 'heal'],
    [/^Item Vehicle /, 'vehicle'],
    [/^Item Upgrade /, 'upgrade'],
    [/^Item (Cart |Power Crystal|Valuable Tracker|Extraction Tracker|Phase Bridge|Duck Bucket|Leaf Blower|WalkieTalkie)/, 'gear']
  ];
  for (const [re, cat] of rules) if (re.test(key)) return cat;
  return 'other';
}

// --- Finding the installed game ----------------------------------------------------------------

/** Steam's own install folder from the registry (Steam may live on any drive). */
function steamPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    // full path: a bare "reg" would also be looked up in the current folder
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(reg, ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    return m ? path.normalize(m[1].trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Locates the R.E.P.O. folder: configured path first, then every Steam library listed in
 * libraryfolders.vdf (Steam's own folder from the registry and the default install paths).
 * @param {string} [configured] gameDir from config.json
 * @returns {string|null}
 */
function findGameDir(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  const steamDirs = [steamPathFromRegistry(), 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(Boolean);
  for (const steam of steamDirs) {
    try {
      const text = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      // VDF escapes backslashes: "path"  "D:\\SteamLibrary"
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        candidates.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common', 'REPO'));
      }
    } catch { /* no Steam here */ }
  }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'REPO_Data', 'resources.assets'))) return dir;
  }
  return null;
}

// --- Reading item names and limits from the game -----------------------------------------------

const MAX_STRING = 200; // longest string accepted while probing binary data
const SCAN_WINDOW = 400; // bytes between display name and prefab path in an Item asset
const MIN_PLAUSIBLE_ITEMS = 20; // fewer found items means the heuristic failed
const MAX_FILE_ID = 64; // a PPtr's fileID points into the file's short list of other files
const PREFAB_PATH = 'Items/';

/**
 * Finds the game's Item ScriptableObjects in resources.assets without a full Unity parser.
 * Without type trees the field layout is not stored in the file, so this looks for the pattern the
 * assets share (verified against all items of builds 23363152 and TESTED_BUILD in lib/server.js):
 *   string m_Name "Item …", int32 status (0 WIP, 1 finished; since build 26294889), int32 disabled
 *   (0/1), string itemName (display name), …, PrefabRef: string prefab name, string prefab path
 *   "Items/<m_Name>" or "Items/Removed Items/<m_Name>" (upper/lower case may differ from m_Name),
 *   PPtr bundle, bool cachedFinalized (since build 26294889); then PPtr to the price `Value`
 *   asset, int32 maxAmount
 * Strings are int32 length + UTF-8 bytes, padded to 4 bytes; a PPtr is int32 fileID + int64 pathID.
 * Both layouts are tried, the newer first; the fields around them tell which one fits.
 * @returns {{ key: string, label: string, disabled: boolean, wip: boolean, max: number|null }[]}
 */
function scanGameItems(gameDir) {
  const buf = fs.readFileSync(path.join(gameDir, 'REPO_Data', 'resources.assets'));
  const readStr = p => {
    if (p < 0 || p + 4 > buf.length) return null;
    const len = buf.readInt32LE(p);
    if (len < 0 || len > MAX_STRING || p + 4 + len > buf.length) return null;
    const s = buf.toString('utf8', p + 4, p + 4 + len);
    // only printable text: random bytes that happen to look like a length are rejected here
    return /^[\x20-\x7e\u00a0-\uffff]*$/.test(s) ? { s, next: align4(p + 4 + len) } : null;
  };
  const flag = p => {
    const v = p >= 0 && p + 4 <= buf.length ? buf.readInt32LE(p) : -1;
    return v === 0 || v === 1 ? v : null;
  };
  // status (newer layout) and disabled, then the display name
  const head = p => {
    for (const withStatus of [true, false]) {
      const status = withStatus ? flag(p) : 1;
      const disabled = flag(withStatus ? p + 4 : p);
      const display = status !== null && disabled !== null && readStr(withStatus ? p + 8 : p + 4);
      if (display && display.s.length >= 1 && display.s.length <= 40) return { wip: status === 0, disabled: disabled === 1, display };
    }
    return null;
  };
  const prefabPath = (key, from) => {
    const want = '/' + key.toLowerCase();
    for (let p = buf.indexOf(PREFAB_PATH, from); p >= 0 && p - from <= SCAN_WINDOW; p = buf.indexOf(PREFAB_PATH, p + 1)) {
      const s = readStr(p - 4);
      if (s && s.s.toLowerCase().endsWith(want)) return s;
    }
    return null;
  };
  // the rest of PrefabRef (newer layout first), the PPtr to the price asset, then maxAmount
  const maxAmount = after => {
    for (const tail of [PPTR_SIZE + 4, PPTR_SIZE]) {
      const value = after + tail;
      if (value + PPTR_SIZE + 4 > buf.length || (tail > PPTR_SIZE && flag(after + PPTR_SIZE) === null)) continue;
      const fileID = buf.readInt32LE(value), max = buf.readInt32LE(value + PPTR_SIZE);
      if (fileID >= 0 && fileID < MAX_FILE_ID && buf.readBigInt64LE(value + 4) > 0n && max > 0 && max < 100) return max;
    }
    return null;
  };
  const found = new Map();
  const needle = Buffer.from('Item ');
  let pos = 0;
  while ((pos = buf.indexOf(needle, pos)) >= 0) {
    const name = readStr(pos - 4); // the length prefix sits right before the text
    pos += needle.length;
    if (!name || !name.s.startsWith('Item ') || name.s.length > 60 || found.has(name.s)) continue;
    const h = head(name.next);
    const prefab = h && prefabPath(name.s, h.display.next);
    if (!prefab) continue;
    found.set(name.s, { key: name.s, label: h.display.s, disabled: h.disabled, wip: h.wip, max: maxAmount(prefab.next) });
  }
  return [...found.values()];
}

/**
 * Built-in list, refreshed with names/limits from the installed game when available.
 * @param {{ scanned?: object[] }} [opts]
 */
function buildCatalog(opts = {}) {
  const items = ITEMS.map(([key, label, cat, max, status]) => ({ key, label, cat, max, disabled: false, wip: status === WIP }));
  let source = 'builtin';
  const scanned = Array.isArray(opts.scanned) ? opts.scanned : [];
  if (scanned.length >= MIN_PLAUSIBLE_ITEMS) {
    const byKey = new Map(items.map(it => [it.key, it]));
    for (const sc of scanned) {
      if (!sc || typeof sc.key !== 'string' || typeof sc.label !== 'string') continue; // cache files are not trusted
      const max = Number.isInteger(sc.max) && sc.max > 0 ? sc.max : null;
      const it = byKey.get(sc.key);
      if (it) {
        it.label = sc.label;
        if (max) it.max = max;
        it.disabled = sc.disabled === true;
        it.wip = sc.wip === true;
      } else {
        const added = { key: sc.key, label: sc.label, cat: categoryFor(sc.key), max: max || 1, disabled: sc.disabled === true, wip: sc.wip === true };
        items.push(added);
        byKey.set(sc.key, added);
      }
    }
    source = 'game';
  }
  return { source, categories: CATEGORIES, items, upgrades: UPGRADES, run: RUN_FIELDS };
}

/** Item catalog for the installed game (cached), or the built-in one. */
function loadCatalog(gameDir, cacheFile) {
  if (!gameDir) return buildCatalog();
  try {
    const st = fs.statSync(path.join(gameDir, 'REPO_Data', 'resources.assets'));
    const stamp = 'items-v3:' + st.size + ':' + Math.round(st.mtimeMs);
    return buildCatalog({ scanned: loadCached(cacheFile, stamp, () => scanGameItems(gameDir)) });
  } catch {
    return buildCatalog();
  }
}

module.exports = { LIMITS, ITEMS, UPGRADES, RUN_FIELDS, categoryFor, findGameDir, scanGameItems, buildCatalog, loadCatalog };
