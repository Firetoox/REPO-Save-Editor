'use strict';
/**
 * Converts the raw ES3 JSON of a save into a flat, editable model and writes a model back.
 *
 * Rules for writing (applyModel):
 * - Only values that differ from the file are written. Values the user did not touch stay exactly
 *   as the game stored them, even explicit zeros or values outside the editor's limits.
 * - `inv` is the complete truck inventory: an item missing from it (or 0) is removed.
 * - Player ids that are not in the save are ignored; at most one player can have the crown.
 * - `upgradesPurchased` only updates counters the game already tracks.
 * - Dictionaries are only created when something is actually written into them.
 *
 * @typedef {object} EditPlayer
 * @property {string} id      Steam ID (key in the save's dictionaries)
 * @property {string} name
 * @property {number|null} hp  null = no playerHealth entry
 * @property {boolean} crown
 * @property {Object<string, number>} up  upgrade level per playerUpgrade* field
 *
 * @typedef {object} EditModel
 * @property {string} team
 * @property {Object<string, number>} run      runStats values (see catalog RUN_FIELDS)
 * @property {EditPlayer[]} players
 * @property {string[]} upgradeFields          all known playerUpgrade* fields plus unknown ones found in the save
 * @property {Object<string, number>} inv      itemsPurchased: item key -> count
 * @property {Object<string, number>} upgradesPurchased  itemsUpgradesPurchased counters
 * @property {number} batteryLow               items whose battery is below 100 %
 * @property {boolean} fillBatteries           request: charge all those batteries
 */

const { UPGRADES, RUN_FIELDS, LIMITS } = require('./catalog');
const { appError } = require('./messages');

const FULL_BATTERY = 100;
/** Item names the editor accepts for new truck entries (also used for profiles). */
const ITEM_KEY = /^Item [A-Za-z0-9 _\-.']{1,60}$/;
const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

const badInput = (code, params) => appError(400, code, params); // the request is wrong
const badFormat = (code, params) => appError(422, code, params); // the file is not a save we understand

/** The dictionary that holds all game data of a save. */
function dictOfDicts(json) {
  const dd = json && json.dictionaryOfDictionaries && json.dictionaryOfDictionaries.value;
  if (!dd || typeof dd !== 'object' || Array.isArray(dd)) throw badFormat('format.noData');
  return dd;
}

/** Value of an ES3 top-level entry ({ __type, value }) or the fallback. */
const es3Value = (json, key, fallback) => (json && json[key] && has(json[key], 'value') ? json[key].value : fallback);

/** Every playerUpgrade* dictionary: the known ones plus new ones from game updates. */
function upgradeFields(dd) {
  const fields = UPGRADES.map(u => u.field);
  for (const k of Object.keys(dd)) if (k.startsWith('playerUpgrade') && !fields.includes(k)) fields.push(k);
  return fields;
}

// JSON.parse keeps "__proto__" as a normal key, but writing it back into an object would change the
// object's prototype instead. The game never uses it, so files containing it are refused.
function checkKeys(obj, name) {
  if (has(obj, '__proto__')) throw badFormat('format.protoKey', { name });
}

/** Checks that a dictionary only holds numbers, so nothing else can reach the UI. */
function numberDict(dd, name) {
  const d = dd[name];
  if (d === undefined) return {};
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw badFormat('format.notDict', { name });
  checkKeys(d, name);
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw badFormat('format.notNumber', { name: name + '.' + k });
  }
  return d;
}

/** Steam IDs of all players: from names, health and upgrade dictionaries. */
function playerIds(json, dd, fields) {
  const names = es3Value(json, 'playerNames', {}) || {};
  checkKeys(names, 'playerNames');
  const ids = new Set(Object.keys(names));
  Object.keys(numberDict(dd, 'playerHealth')).forEach(id => ids.add(id));
  fields.forEach(f => Object.keys(numberDict(dd, f)).forEach(id => ids.add(id)));
  return ids;
}

/**
 * Reads the editable values of a save.
 * @param {object} json decrypted save
 * @returns {EditModel}
 */
function toModel(json) {
  const dd = dictOfDicts(json);
  const names = es3Value(json, 'playerNames', {}) || {};
  const fields = upgradeFields(dd);
  const health = numberDict(dd, 'playerHealth');
  const crowns = numberDict(dd, 'playerHasCrown');
  const upgradeDicts = Object.fromEntries(fields.map(f => [f, numberDict(dd, f)]));

  const run = {};
  const rs = dd.runStats || {};
  for (const f of RUN_FIELDS) if (typeof rs[f.key] === 'number' && Number.isFinite(rs[f.key])) run[f.key] = rs[f.key];

  // own keys only: an id like "constructor" must not pick up inherited values
  const players = [...playerIds(json, dd, fields)].map(id => ({
    id,
    name: has(names, id) && typeof names[id] === 'string' && names[id] ? names[id] : id,
    hp: has(health, id) ? health[id] : null,
    crown: has(crowns, id) && !!crowns[id],
    up: Object.fromEntries(fields.map(f => [f, has(upgradeDicts[f], id) ? upgradeDicts[f][id] : 0]))
  }));

  const battery = numberDict(dd, 'itemStatBattery');
  const team = es3Value(json, 'teamName', '');
  return {
    team: typeof team === 'string' ? team : '',
    run,
    players,
    upgradeFields: fields,
    inv: Object.assign({}, numberDict(dd, 'itemsPurchased')),
    // Upgrades bought so far, per upgrade item. The shop raises upgrade prices with this count.
    upgradesPurchased: Object.assign({}, numberDict(dd, 'itemsUpgradesPurchased')),
    batteryLow: Object.values(battery).filter(v => v >= 0 && v < FULL_BATTERY).length,
    fillBatteries: false
  };
}

/** Rounds and clamps a number from the client; refuses non-numbers (400). */
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (v === '' || v === null || !Number.isFinite(n)) throw badInput('input.number', { value: String(v).slice(0, 30) });
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Writes the model back into the save JSON (in place). See the rules at the top of this file.
 * @param {object} json decrypted save, modified in place
 * @param {Partial<EditModel>} model from the UI
 * @returns {object} json
 */
function applyModel(json, model) {
  if (!model || typeof model !== 'object') throw badInput('input.changes');
  const dd = dictOfDicts(json);
  const fields = upgradeFields(dd);
  const known = playerIds(json, dd, fields);
  // same checks as toModel for the dictionaries written below (the file may have changed meanwhile)
  ['itemsPurchased', 'itemsUpgradesPurchased', 'playerHasCrown', 'itemStatBattery'].forEach(name => numberDict(dd, name));
  const own = (dict, key) => (has(dict, key) ? dict[key] : undefined); // never inherited values

  if (typeof model.team === 'string' && json.teamName && json.teamName.value !== model.team) {
    json.teamName.value = model.team.slice(0, LIMITS.teamName);
    if (json.teamNameChanged) json.teamNameChanged.value = true;
  }

  if (model.run && typeof model.run === 'object') {
    for (const f of RUN_FIELDS) {
      if (!has(model.run, f.key)) continue;
      const stored = own(dd.runStats, f.key);
      if (model.run[f.key] === stored) continue; // untouched, even if outside our limits
      const v = clampInt(model.run[f.key], f.min, f.max);
      if (v === stored) continue;
      dd.runStats = dd.runStats || {};
      dd.runStats[f.key] = v;
    }
  }

  const players = Array.isArray(model.players)
    ? model.players.filter(p => p && typeof p.id === 'string' && known.has(p.id))
    : null;
  for (const p of players || []) {
    if (p.hp !== null && p.hp !== undefined) {
      const stored = own(dd.playerHealth, p.id);
      if (p.hp !== stored) {
        const hp = clampInt(p.hp, 0, LIMITS.hp);
        if (hp !== stored) {
          dd.playerHealth = dd.playerHealth || {};
          dd.playerHealth[p.id] = hp;
        }
      }
    }
    for (const f of fields) {
      if (!p.up || !has(p.up, f)) continue;
      const stored = own(dd[f], p.id) || 0; // a missing entry means level 0
      if (p.up[f] === stored) continue;
      const v = clampInt(p.up[f], 0, LIMITS.upgradeLevel);
      if (v === stored) continue;
      dd[f] = dd[f] || {};
      dd[f][p.id] = v;
    }
  }

  // The game stores crown holders as { steamId: 1 }. Rewrite only if the holder among the save's
  // players changed; entries for ids that are not players are kept.
  if (players) {
    const wanted = players.filter(p => p.crown).map(p => p.id).sort();
    const had = dd.playerHasCrown || {};
    const current = Object.keys(had).filter(id => had[id] && players.some(p => p.id === id)).sort();
    if (wanted.join() !== current.join()) {
      if (wanted.length > 1) throw badInput('input.oneCrown');
      const crowns = {};
      for (const [id, v] of Object.entries(had)) if (!players.some(p => p.id === id)) crowns[id] = v;
      for (const id of wanted) crowns[id] = 1;
      dd.playerHasCrown = crowns;
    }
  }

  if (model.inv && typeof model.inv === 'object') {
    const old = dd.itemsPurchased || {};
    const next = {};
    let changed = false;
    // keep the game's order; a key missing from model.inv or set to 0 removes the item
    for (const k of Object.keys(old)) {
      const want = has(model.inv, k) ? model.inv[k] : 0;
      if (want === old[k]) { next[k] = old[k]; continue; }
      const v = clampInt(want, 0, LIMITS.itemCount);
      if (v === old[k]) { next[k] = old[k]; continue; }
      changed = true;
      if (v > 0) next[k] = v;
    }
    // new items go to the end
    for (const k of Object.keys(model.inv)) {
      if (has(old, k)) continue;
      if (!ITEM_KEY.test(k)) throw badInput('input.itemName', { name: k.slice(0, 60) });
      const v = clampInt(model.inv[k], 0, LIMITS.itemCount);
      if (v > 0) { next[k] = v; changed = true; }
    }
    if (changed) dd.itemsPurchased = next;
  }

  if (model.upgradesPurchased && typeof model.upgradesPurchased === 'object' && dd.itemsUpgradesPurchased) {
    const counters = dd.itemsUpgradesPurchased;
    for (const k of Object.keys(model.upgradesPurchased)) {
      if (!has(counters, k)) continue; // only counters the game already tracks
      if (model.upgradesPurchased[k] === counters[k]) continue;
      const v = clampInt(model.upgradesPurchased[k], 0, LIMITS.purchases);
      if (v !== counters[k]) counters[k] = v;
    }
  }

  if (model.fillBatteries === true && dd.itemStatBattery) {
    // only raise real charge values; anything else (e.g. negative markers) stays untouched
    for (const [k, v] of Object.entries(dd.itemStatBattery)) {
      if (typeof v === 'number' && v >= 0 && v < FULL_BATTERY) dd.itemStatBattery[k] = FULL_BATTERY;
    }
  }
  return json;
}

module.exports = { toModel, applyModel, dictOfDicts, es3Value, ITEM_KEY };
