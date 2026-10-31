'use strict';
/**
 * Cosmetics (MetaSave.es3). The save stores cosmetic numbers in `cosmeticUnlocks`; each number is
 * the position in MetaManager.cosmeticAssets (a component in REPO_Data/level0). The list entries
 * point to CosmeticAsset objects in sharedassets0.assets, which hold name, type and rarity.
 * Read-only; falls back to the list shipped with the editor (lib/cosmetics.json).
 */

const fs = require('fs');
const path = require('path');
const unity = require('./unity');
const { loadCached } = require('./cache');

/** Index = rarity value stored in a CosmeticAsset (0-3); names as in the game's reward sounds. */
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Ultra Rare'];
const OTHER = 'Other'; // category for types without a CosmeticCategoryAsset
const MIN_PLAUSIBLE_COSMETICS = 100; // fewer means the scan went wrong
const MAX_ARRAY = 5000; // upper bound for PPtr arrays when probing MetaManager's fields
const MAX_TYPE_LIST = 200;

/** Opens the three game files and resolves the script ids the scan needs. */
function openGameFiles(gameDir) {
  const data = path.join(gameDir, 'REPO_Data');
  const ggm = unity.parseSerializedFile(path.join(data, 'globalgamemanagers.assets'));
  const scripts = unity.monoScripts(ggm);
  const sid = {
    meta: scripts.get('MetaManager'),
    asset: scripts.get('CosmeticAsset'),
    type: scripts.get('CosmeticTypeAsset'),
    category: scripts.get('CosmeticCategoryAsset')
  };
  if (!sid.meta || !sid.asset || !sid.type) throw new Error('Cosmetic scripts not found');
  const level = unity.parseSerializedFile(path.join(data, 'level0'));
  const shared = unity.parseSerializedFile(path.join(data, 'sharedassets0.assets'));
  return {
    sid,
    level,
    shared,
    ggmInLevel: unity.externalIndex(level, 'globalgamemanagers.assets'),
    ggmInShared: unity.externalIndex(shared, 'globalgamemanagers.assets'),
    sharedInLevel: unity.externalIndex(level, 'sharedassets0.assets')
  };
}

/** MonoBehaviour header for an object of sharedassets0, or null if it is not one we can read. */
function sharedScriptObject(g, pathID) {
  const o = g.shared.byPath.get(pathID);
  if (!o || o.classID !== unity.CLASS_MONOBEHAVIOUR) return null;
  try {
    const mb = unity.monoBehaviour(g.shared, o);
    return mb.scriptFile === g.ggmInShared ? { script: mb.scriptPath, mb } : null;
  } catch {
    return null;
  }
}

function findMetaManager(g) {
  const isMetaManager = o => {
    if (o.classID !== unity.CLASS_MONOBEHAVIOUR) return false;
    try {
      const mb = unity.monoBehaviour(g.level, o);
      return mb.scriptFile === g.ggmInLevel && mb.scriptPath === g.sid.meta;
    } catch {
      return false;
    }
  };
  const meta = g.level.objects.find(isMetaManager);
  if (!meta) throw new Error('MetaManager not found');
  return unity.monoBehaviour(g.level, meta);
}

/**
 * Without type trees the field offsets inside MetaManager are unknown. Its data is therefore probed
 * at every 4-byte offset for a serialized PPtr array: i32 count n, then n PPtrs that all point into
 * sharedassets0.assets. The script of the first element tells the kind of list; if several arrays
 * of one kind match, the longest wins (cosmeticAssets is the complete list).
 */
function findPPtrArrays(g, mm) {
  const b = g.level.buf;
  const arrays = {};
  for (let p = mm.fieldsStart; p < mm.end - 4; p += 4) {
    const n = b.readInt32LE(p);
    if (n < 1 || n > MAX_ARRAY || p + 4 + n * unity.PPTR_SIZE > mm.end) continue;
    const refs = [];
    for (let i = 0; i < n; i++) {
      const q = p + 4 + i * unity.PPTR_SIZE;
      if (b.readInt32LE(q) !== g.sharedInLevel) break;
      refs.push(b.readBigInt64LE(q + 4));
    }
    if (refs.length !== n) continue;
    const first = sharedScriptObject(g, refs[0]);
    if (!first) continue;
    const kind = first.script === g.sid.asset ? 'asset' : first.script === g.sid.type ? 'type' : first.script === g.sid.category ? 'category' : null;
    if (kind && (!arrays[kind] || arrays[kind].length < n)) arrays[kind] = refs;
    p += n * unity.PPTR_SIZE; // continue after the array
  }
  if (!arrays.asset || !arrays.type) throw new Error('Cosmetic list not found in MetaManager');
  return arrays;
}

/** CosmeticTypeAsset fields: i32 type index, string display name. */
function readTypes(g, refs) {
  const types = new Map();
  for (const ref of refs) {
    const s = sharedScriptObject(g, ref);
    if (!s) continue;
    const buf = g.shared.buf;
    types.set(buf.readInt32LE(s.mb.fieldsStart), { name: unity.readString(buf, s.mb.fieldsStart + 4).s, category: null });
  }
  return types;
}

/** CosmeticCategoryAsset fields: string name, PPtr icon, i32 count + i32 type indices. */
function readCategories(g, refs, types) {
  for (const ref of refs || []) {
    const s = sharedScriptObject(g, ref);
    if (!s) continue;
    const buf = g.shared.buf;
    const name = unity.readString(buf, s.mb.fieldsStart);
    const p = name.next + unity.PPTR_SIZE;
    const n = buf.readInt32LE(p);
    for (let i = 0; i < n && i < MAX_TYPE_LIST; i++) {
      const t = types.get(buf.readInt32LE(p + 4 + i * 4));
      if (t && !t.category) t.category = name.s;
    }
  }
}

/**
 * CosmeticAsset fields: i32 status (work state for the developers, not shown), string name, i32 type
 * index, i32 rarity (0-3), PrefabRef (string prefab name, string prefab path, PPtr bundle, since
 * build 26294889 also bool cachedFinalized), i32 count + i32 list, bool tintable ("colorable": 0 for
 * textures like Rusty or Graffiti), PPtr default colour, newer builds more fields.
 * Returns the entry without the colour flag plus `after`, the position right after the prefab path.
 */
function readCosmetic(g, ref, id, types) {
  const unknown = { id, name: 'Cosmetic ' + id, type: '', category: OTHER, rarity: null, after: null, end: 0 };
  const s = sharedScriptObject(g, ref);
  if (!s) return unknown;
  const buf = g.shared.buf;
  try {
    const name = unity.readString(buf, s.mb.fieldsStart + 4);
    let p = name.next;
    const t = types.get(buf.readInt32LE(p)) || { name: '', category: null };
    const rarity = buf.readInt32LE(p + 4);
    p += 8;
    let after = null;
    try {
      p = unity.readString(buf, p).next; // prefab name
      after = unity.readString(buf, p).next; // prefab path
    } catch { /* layout changed: colour flag unknown */ }
    return { id, name: name.s, type: t.name, category: t.category || OTHER, rarity: rarity >= 0 && rarity < RARITIES.length ? rarity : null, after, end: s.mb.end };
  } catch {
    return unknown;
  }
}

/** The rest of PrefabRef after the prefab path, newest layout first (see readCosmetic). */
const PREFAB_TAILS = [unity.PPTR_SIZE + 4, unity.PPTR_SIZE];

/** The colour flag for one PrefabRef layout, or null if the bytes do not fit that layout. */
function tintable(buf, after, end, tail) {
  const p = after + tail;
  if (p + 4 > end) return null;
  if (tail > unity.PPTR_SIZE) {
    const cachedFinalized = buf.readInt32LE(after + unity.PPTR_SIZE);
    if (cachedFinalized !== 0 && cachedFinalized !== 1) return null;
  }
  const n = buf.readInt32LE(p);
  if (n < 0 || n > 100 || p + 4 + n * 4 >= end) return null;
  const flag = buf[p + 4 + n * 4];
  return flag === 0 || flag === 1 ? flag === 1 : null;
}

/**
 * Reads the complete cosmetic list (index = number stored in MetaSave) from the game files.
 * A single cosmetic can fit both PrefabRef layouts by chance, so the layout that fits more of them
 * is used for all.
 */
function scanCosmetics(gameDir) {
  const g = openGameFiles(gameDir);
  const arrays = findPPtrArrays(g, findMetaManager(g));
  const types = readTypes(g, arrays.type);
  readCategories(g, arrays.category, types);
  const read = arrays.asset.map((ref, id) => readCosmetic(g, ref, id, types));
  const flag = (r, tail) => (r.after === null ? null : tintable(g.shared.buf, r.after, r.end, tail));
  const fits = tail => read.filter(r => flag(r, tail) !== null).length;
  const tail = PREFAB_TAILS.reduce((best, t) => (fits(t) > fits(best) ? t : best));
  return read.map(r => ({ id: r.id, name: r.name, type: r.type, category: r.category, rarity: r.rarity, colorable: flag(r, tail) }));
}

/** Cache and shipped files are data, not code: keep only well-formed entries. */
function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c, i) => ({
    id: i,
    name: c && typeof c.name === 'string' ? c.name : 'Cosmetic ' + i,
    type: c && typeof c.type === 'string' ? c.type : '',
    category: c && typeof c.category === 'string' ? c.category : OTHER,
    rarity: c && Number.isInteger(c.rarity) && c.rarity >= 0 && c.rarity < RARITIES.length ? c.rarity : null,
    colorable: c && typeof c.colorable === 'boolean' ? c.colorable : null
  }));
}

function shippedList() {
  try { return sanitize(JSON.parse(fs.readFileSync(path.join(__dirname, 'cosmetics.json'), 'utf8'))); } catch { return []; }
}

/**
 * Cosmetic list for the installed game (cached), or the shipped one.
 * @returns {{ source: 'game'|'builtin', rarities: string[], list: object[], fallbackReason?: string }}
 */
function loadCosmetics(gameDir, cacheFile) {
  if (!gameDir) return { source: 'builtin', rarities: RARITIES, list: shippedList() };
  try {
    const stamp = 'cosmetics-v4:' + ['sharedassets0.assets', 'level0', 'globalgamemanagers.assets'].map(f => {
      const st = fs.statSync(path.join(gameDir, 'REPO_Data', f));
      return st.size + '/' + Math.round(st.mtimeMs);
    }).join(':');
    const list = sanitize(loadCached(cacheFile, stamp, () => {
      const scanned = scanCosmetics(gameDir);
      if (scanned.length < MIN_PLAUSIBLE_COSMETICS) throw new Error('Cosmetic list incomplete');
      return scanned;
    }));
    return { source: 'game', rarities: RARITIES, list };
  } catch (e) {
    return { source: 'builtin', rarities: RARITIES, list: shippedList(), fallbackReason: e.message };
  }
}

module.exports = { RARITIES, scanCosmetics, loadCosmetics };
