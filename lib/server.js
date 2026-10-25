'use strict';
/**
 * Local HTTP backend of the editor, used by the Windows app (electron/main.js) and by server.js.
 *
 * Security model
 * - Listens on 127.0.0.1 only.
 * - Answers only requests whose Host header is 127.0.0.1:<port> or localhost:<port>. A website that
 *   points its own host name at 127.0.0.1 (DNS rebinding) still sends its own name and is refused.
 * - Every /api request must carry the header X-REPO-Editor: <session token>. The token is random per
 *   start and only known to the editor's own page. A custom header also forces a CORS preflight for
 *   cross-site requests, which is never answered positively.
 * - Requests from other sites (Origin / Sec-Fetch-Site) are refused; the page sends a strict
 *   Content-Security-Policy and may not be framed.
 * - All file names come from validated ids (SAVE_ID, FILE_NAME); writes only go to the saves folder,
 *   MetaSave.es3 and the backup folder.
 *
 * Messages for the user come from lib/messages.js in the language the page asks for (X-REPO-Lang).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const es3 = require('./es3');
const { appError, errorText, message, normalize, LANGUAGES } = require('./messages');
const { toModel, applyModel, dictOfDicts, es3Value, ITEM_KEY } = require('./model');
const { findGameDir, loadCatalog, LIMITS, RUN_FIELDS } = require('./catalog');
const { loadCosmetics } = require('./cosmetics');
const { findPassword } = require('./password');
const { readJson } = require('./json-file');
const pkg = require('../package.json');

const DEFAULT_SAVES_DIR = path.join(os.homedir(), 'AppData', 'LocalLow', 'semiwork', 'Repo', 'saves');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Windows programs by full path: a bare name is also looked up in the current folder.
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const TASKLIST = path.join(SYSTEM_ROOT, 'System32', 'tasklist.exe');
const EXPLORER = path.join(SYSTEM_ROOT, 'explorer.exe');
const TASKLIST_TIMEOUT_MS = 5000;
const STEAM_APP_ID = '3241660';
// Steam build of R.E.P.O. the editor was last checked against.
const TESTED_BUILD = '23363152';

const SAVE_ID = /^REPO_SAVE_[0-9_]+$/;
const FILE_NAME = /^[A-Za-z0-9_-]+\.es3$/;
const GAME_BACKUP = /_BACKUP(\d+)\.es3$/;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DROP_BODY_BYTES = 4 * MAX_BODY_BYTES; // beyond this the connection is cut instead of read to the end
const MAX_UNLOCKS = 10000; // cosmetic ids per request (the game has a few hundred)
const PROBE_SAVES = 5; // saves offered to the password search besides MetaSave
const SLOT_TRIES = 60; // duplicate: slot names are times in seconds, so this is up to a minute ahead
const BACKUP_NAME_TRIES = 100; // backups made within the same millisecond get -1, -2, …
const MAX_PROFILES = 200;
const MAX_PROFILE_KEYS = 200; // values per map in a profile (run, upgrades, items)

// Reasons are part of the backup file names on disk. Backups named with the German reasons below
// are listed under the English ones.
const REASON = { original: 'original', beforeSave: 'before-save', manual: 'manual', beforeRestore: 'before-restore' };
const OLD_REASON = { 'vor-schreiben': REASON.beforeSave, manuell: REASON.manual, 'vor-wiederherstellen': REASON.beforeRestore };
const reasonOf = file => {
  const reason = (file.match(/_([a-z-]+)\.es3$/) || [])[1] || '';
  return Object.prototype.hasOwnProperty.call(OLD_REASON, reason) ? OLD_REASON[reason] : reason;
};

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function pad(n, len = 2) { return String(n).padStart(len, '0'); }

/** Local time stamp with milliseconds, used at the start of backup file names. */
function stamp(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' +
    pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds()) + '-' + pad(d.getMilliseconds(), 3);
}

/** 409 when the file changed since it was loaded; `reason` lets the UI offer "Reload". */
const changedError = () => Object.assign(appError(409, 'save.changed'), { reason: 'changed' });

/** Reads a save or backup file; absurdly large files are refused before they are loaded. */
function readSaveFile(file) {
  if (fs.statSync(file).size > es3.MAX_FILE_BYTES) throw appError(413, 'file.tooLarge');
  return fs.readFileSync(file);
}

// The user folder in any case and with \ or /, but not a longer folder name that starts the same.
const HOME_PATTERN = new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '[\\\\/]') + '(?![^\\\\/\\s"\'])', 'gi');
/** Replaces the user folder (it contains the Windows user name) in messages for the UI and the log. */
function maskPaths(msg) {
  return String(msg).replace(HOME_PATTERN, '%USERPROFILE%');
}

const SCRIPT_OPEN = '<script>';
const SCRIPT_CLOSE = '</script>';

/**
 * Inline scripts of the editor's own page (public/index.html), e.g. for their CSP hashes. A plain
 * search for the exact tags the page uses: the file is part of the editor, not untrusted HTML.
 * @returns {{ start: number, text: string }[]} start = position of the script text in `html`
 */
function inlineScripts(html) {
  const scripts = [];
  let from = 0;
  for (;;) {
    const open = html.indexOf(SCRIPT_OPEN, from);
    if (open < 0) return scripts;
    const start = open + SCRIPT_OPEN.length;
    const end = html.indexOf(SCRIPT_CLOSE, start);
    if (end < 0) return scripts;
    scripts.push({ start, text: html.slice(start, end) });
    from = end + SCRIPT_CLOSE.length;
  }
}

/** Short facts about a save for lists; never throws (broken files are reported with ok: false). */
function summarize(file, lang, codec) {
  const st = fs.statSync(file);
  try {
    const { json } = codec.readSave(readSaveFile(file));
    const rs = dictOfDicts(json).runStats || {};
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const team = es3Value(json, 'teamName', '');
    const names = es3Value(json, 'playerNames', {}) || {};
    return {
      ok: true,
      mtime: st.mtimeMs,
      team: typeof team === 'string' ? team : '',
      date: String(es3Value(json, 'dateAndTime', '') || ''),
      timePlayed: num(es3Value(json, 'timePlayed', 0)) || 0,
      level: num(rs.level),
      currency: num(rs.currency),
      players: Object.values(names).map(String)
    };
  } catch (e) {
    return { ok: false, mtime: st.mtimeMs, error: maskPaths(errorText(e, lang)) };
  }
}

const TEMP_SUFFIX = '.editor-tmp';
const STALE_TEMP_MS = 60 * 1000;
// A virus scanner, the search indexer or OneDrive may hold a file for a moment.
const RENAME_TRIES = 5;
const RENAME_PAUSE_MS = 100;
const LOCK_CODES = ['EPERM', 'EBUSY', 'EACCES'];

/** Blocks for a moment; only used between retries of a file operation. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Renames, retrying a few times while another program briefly holds the file. */
function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_TRIES || !LOCK_CODES.includes(e.code)) throw e;
      pause(RENAME_PAUSE_MS);
    }
  }
}

/** Removes temp files an interrupted write left behind (only old ones, so never one in use). */
function removeStaleTemps(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names.filter(n => n.endsWith(TEMP_SUFFIX))) {
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_TEMP_MS) fs.unlinkSync(file);
    } catch { /* in use or already gone */ }
  }
}

/**
 * Writes a file so that it is either completely old or completely new: a temp file next to it is
 * written and flushed, then renamed over the original. If `expectedHash` is given, the original
 * must still have that content right before the rename (the game may have saved in between).
 */
function writeAtomic(file, data, expectedHash) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + TEMP_SUFFIX;
  const fd = fs.openSync(tmp, 'wx');
  try {
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (expectedHash && sha1(readSaveFile(file)) !== expectedHash) throw changedError();
    renameRetrying(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Encrypts like the original (same flags, fresh IV) and proves the result decrypts to the same data. */
function encodeChecked(json, format, codec) {
  const out = codec.writeSave(json, { encrypted: format.encrypted, gzipped: format.gzipped });
  const check = codec.readSave(out);
  if (JSON.stringify(check.json) !== JSON.stringify(json)) throw appError(500, 'write.verifyFailed');
  return out;
}

function readSteamBuild(gameDir) {
  if (!gameDir) return null;
  try {
    // gameDir is <library>/steamapps/common/REPO; the manifest lives in <library>/steamapps
    const acf = fs.readFileSync(path.join(gameDir, '..', '..', 'appmanifest_' + STEAM_APP_ID + '.acf'), 'utf8');
    const build = (acf.match(/"buildid"\s+"(\d+)"/) || [])[1] || null;
    const updated = Number((acf.match(/"LastUpdated"\s+"(\d+)"/) || [])[1] || 0) * 1000 || null;
    return { build, updated };
  } catch {
    return null;
  }
}

/**
 * Expert mode may change values, not the shape of the save: every top-level entry and every
 * dictionary the file has must still be there, with the same ES3 type.
 */
function checkSameStructure(current, next) {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  for (const [key, entry] of Object.entries(current)) {
    if (!own(next, key)) throw appError(400, 'raw.missing', { name: key });
    const before = entry && entry.__type, after = next[key] && next[key].__type;
    if (before !== after) throw appError(400, 'raw.typeChanged', { name: key, from: String(before), to: String(after) });
  }
  const dd = dictOfDicts(current), nextDd = dictOfDicts(next);
  for (const key of Object.keys(dd)) {
    if (!own(nextDd, key)) throw appError(400, 'raw.missing', { name: 'dictionaryOfDictionaries.' + key });
  }
}

/** Plain JSON object or 400 (bodies must be objects; arrays, null etc. are refused). */
function plainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw appError(400, 'request.invalid');
  return v;
}

/** Profiles are stored data: keep only flat { key: number } maps with known key shapes. */
function cleanNumberMap(o, keyOk, max) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, MAX_PROFILE_KEYS)) {
    if (keyOk(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.min(max, Math.round(v)));
  }
  return Object.keys(out).length ? out : null;
}

/**
 * @param {object} opts
 * @param {string} opts.backupDir                where the editor keeps its backups
 * @param {string} [opts.savesDir]               default: the game's saves folder
 * @param {string} [opts.metaFile]               default: MetaSave.es3 next to the saves folder
 * @param {string|false} [opts.gameDir]          game folder; false = do not look for the game (tests)
 * @param {string} [opts.password]              tests only: save password (normally read from the game files)
 * @param {string} [opts.dataDir]                profiles and list caches (default: backupDir)
 * @param {string} [opts.appVersion]
 * @param {string} [opts.configFile]             shown in the info dialog
 * @param {boolean} [opts.skipGameCheck]         tests only: never report the game as running
 * @param {boolean} [opts.demoPaths]             screenshots only: show standard paths
 * @param {() => Promise<boolean|null>} [opts.isGameRunning]  replace the tasklist check (tests; null = unknown)
 * @param {(dir: string) => void} [opts.openFolder]      replace explorer.exe (tests)
 * @param {(...msg: string[]) => void} [opts.log]
 */
function createEditor(opts) {
  const SAVES_DIR = path.resolve(opts.savesDir || DEFAULT_SAVES_DIR);
  const META_FILE = path.resolve(opts.metaFile || path.join(path.dirname(SAVES_DIR), 'MetaSave.es3'));
  const META_BAK = META_FILE.replace(/\.es3$/i, '') + '.bak'; // the game's own copy of MetaSave
  const BACKUP_DIR = path.resolve(opts.backupDir);
  const META_BACKUPS = path.join(BACKUP_DIR, 'MetaSave');
  const DATA_DIR = path.resolve(opts.dataDir || BACKUP_DIR);
  const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
  // UI settings live here, not in the page's localStorage: the page's origin changes with the
  // random port on every start, so localStorage would forget them.
  const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
  const GAME_DIR = opts.gameDir === false ? null : findGameDir(opts.gameDir);
  const catalog = loadCatalog(GAME_DIR, path.join(DATA_DIR, 'catalog-cache.json'));
  const cosmetics = loadCosmetics(GAME_DIR, path.join(DATA_DIR, 'cosmetics-cache.json'));
  const log = opts.log || (() => {});
  const home = os.homedir();
  const TOKEN = crypto.randomBytes(24).toString('hex');
  const TOKEN_BYTES = Buffer.from(TOKEN);

  // The save password is read from the game files when it is first needed (see lib/password.js).
  // Tests pass their own. A failed search is repeated only when the files to test on change.
  let password = opts.password || null;
  let passwordMiss = { key: null, reason: null };
  function gamePassword() {
    if (password) return password;
    const candidates = encryptedCandidates();
    const key = candidates.map(f => f + ':' + safeSize(f)).join('|');
    if (passwordMiss.key === key) return null;
    const found = findPassword({ gameDir: GAME_DIR, files: candidates, cacheFile: path.join(DATA_DIR, 'password-cache.json') });
    if (found.password) password = found.password;
    else { passwordMiss = { key, reason: found.reason }; log('Save password not found: ' + found.reason); }
    return password;
  }
  const es3Files = es3.codec(gamePassword); // read/write .es3 files with the game's password
  /** For the UI: found, or why not (noGame, noDll, noProbe, notFound). */
  const passwordState = () => (gamePassword() ? { found: true } : { found: false, reason: passwordMiss.reason });

  /** .es3 files that may be encrypted with the game's password: MetaSave and the saves. */
  function encryptedCandidates() {
    const list = [META_FILE, META_BAK];
    try {
      for (const id of fs.readdirSync(SAVES_DIR).filter(x => SAVE_ID.test(x)).slice(0, PROBE_SAVES)) list.push(path.join(SAVES_DIR, id, id + '.es3'));
    } catch { /* no saves folder */ }
    return list.filter(f => fs.existsSync(f));
  }
  function safeSize(file) { try { return fs.statSync(file).size; } catch { return 0; } }
  /** Constant-time comparison, so the answer time tells nothing about the token. */
  function tokenOk(header) {
    const given = Buffer.from(typeof header === 'string' ? header : '');
    return given.length === TOKEN_BYTES.length && crypto.timingSafeEqual(given, TOKEN_BYTES);
  }

  // How paths are shown in the UI: the user folder becomes %USERPROFILE% (no user name on screen).
  // demoPaths (screenshots only) shows the standard locations instead of the real test folders.
  const pathAliases = [];
  if (opts.demoPaths) {
    pathAliases.push([SAVES_DIR, '%USERPROFILE%\\AppData\\LocalLow\\semiwork\\Repo\\saves']);
    pathAliases.push([META_FILE, '%USERPROFILE%\\AppData\\LocalLow\\semiwork\\Repo\\MetaSave.es3']);
    pathAliases.push([BACKUP_DIR, '%USERPROFILE%\\Documents\\REPO Save Editor\\Backups']);
    if (GAME_DIR) pathAliases.push([GAME_DIR, 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\REPO']);
  }
  pathAliases.push([home, '%USERPROFILE%']);
  pathAliases.sort((a, b) => b[0].length - a[0].length);

  // --- files and ids ---------------------------------------------------------------------------

  function saveDir(id) {
    if (!SAVE_ID.test(id || '')) throw appError(400, 'input.saveId');
    const dir = path.join(SAVES_DIR, id);
    if (!fs.existsSync(path.join(dir, id + '.es3'))) throw appError(404, 'save.notFound', { id });
    return dir;
  }
  const mainFile = id => path.join(saveDir(id), id + '.es3');
  function backupDirFor(id) {
    if (!SAVE_ID.test(id || '')) throw appError(400, 'input.saveId');
    return path.join(BACKUP_DIR, id);
  }

  /** true, false, or null when it could not be checked; then nothing is written (requireGameClosed). */
  function isGameRunning() {
    if (opts.skipGameCheck) return Promise.resolve(false);
    if (opts.isGameRunning) return opts.isGameRunning();
    return new Promise(resolve => {
      if (process.platform !== 'win32') return resolve(false);
      execFile(TASKLIST, ['/FI', 'IMAGENAME eq REPO.exe', '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: TASKLIST_TIMEOUT_MS }, (err, out) => {
        if (err) {
          log('tasklist failed: ' + err.message);
          return resolve(null);
        }
        resolve(/"REPO\.exe"/i.test(out || ''));
      });
    });
  }
  async function requireGameClosed() {
    const running = await isGameRunning();
    if (running) throw appError(409, 'game.running');
    if (running === null) throw appError(409, 'game.unknown');
  }

  function listSaves(lang) {
    if (!fs.existsSync(SAVES_DIR)) return [];
    return fs.readdirSync(SAVES_DIR)
      .filter(id => SAVE_ID.test(id) && fs.existsSync(path.join(SAVES_DIR, id, id + '.es3')))
      .map(id => {
        const files = fs.readdirSync(path.join(SAVES_DIR, id));
        const bdir = backupDirFor(id);
        return Object.assign({ id }, summarize(path.join(SAVES_DIR, id, id + '.es3'), lang, es3Files), {
          gameBackups: files.filter(f => GAME_BACKUP.test(f)).length,
          editorBackups: fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => FILE_NAME.test(f)).length : 0
        });
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  // --- backups ---------------------------------------------------------------------------------

  /** Copies src into dir as <stamp>_<reason>.es3 without ever overwriting an existing backup. */
  function copyBackup(src, dir, reason) {
    fs.mkdirSync(dir, { recursive: true });
    const base = stamp();
    for (let n = 0; n < BACKUP_NAME_TRIES; n++) {
      const name = (n ? base + '-' + n : base) + '_' + reason + '.es3';
      try {
        fs.copyFileSync(src, path.join(dir, name), fs.constants.COPYFILE_EXCL);
        return name;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw appError(500, 'backup.noFreeName');
  }
  const makeBackup = (id, reason) => copyBackup(mainFile(id), backupDirFor(id), reason);
  const makeMetaBackup = reason => copyBackup(META_FILE, META_BACKUPS, reason);

  /**
   * Keeps an untouched copy of every save (and of MetaSave) the first time the editor sees it.
   * Also clears temp files that an interrupted write may have left next to them.
   */
  function backupOriginals() {
    const made = [];
    const hasOriginal = dir => fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('_' + REASON.original + '.es3'));
    [path.dirname(META_FILE), DATA_DIR].forEach(removeStaleTemps);
    for (const s of listSaves()) {
      removeStaleTemps(path.join(SAVES_DIR, s.id));
      if (!hasOriginal(backupDirFor(s.id))) { makeBackup(s.id, REASON.original); made.push(s.id); }
    }
    if (fs.existsSync(META_FILE) && !hasOriginal(META_BACKUPS)) { makeMetaBackup(REASON.original); made.push('MetaSave'); }
    return made;
  }

  const backupNo = f => Number((f.match(GAME_BACKUP) || [0, 0])[1]);
  // Newest first; same time: editor before game backups, then higher BACKUPn, then name.
  function byNewest(a, b) {
    if (a.mtime !== b.mtime) return b.mtime - a.mtime;
    if (a.source !== b.source) return a.source === 'editor' ? -1 : 1;
    return backupNo(b.file) - backupNo(a.file) || b.file.localeCompare(a.file);
  }

  function listBackups(id, lang) {
    const sdir = saveDir(id);
    const out = [];
    const bdir = backupDirFor(id);
    if (fs.existsSync(bdir)) {
      for (const f of fs.readdirSync(bdir).filter(name => FILE_NAME.test(name))) {
        out.push(Object.assign({ source: 'editor', file: f, reason: reasonOf(f) }, summarize(path.join(bdir, f), lang, es3Files)));
      }
    }
    for (const f of fs.readdirSync(sdir).filter(name => GAME_BACKUP.test(name))) {
      out.push(Object.assign({ source: 'game', file: f, reason: 'game' }, summarize(path.join(sdir, f), lang, es3Files)));
    }
    return out.sort(byNewest);
  }

  /** Path of a backup of save `id`: an editor backup or one of the game's own _BACKUPn files. */
  function backupPath(id, source, file) {
    if (!FILE_NAME.test(file || '')) throw appError(400, 'input.fileName');
    if (source === 'editor') return path.join(backupDirFor(id), file);
    if (source === 'game' && GAME_BACKUP.test(file) && file.startsWith(id + '_')) return path.join(saveDir(id), file);
    throw appError(400, 'input.backupSource');
  }

  // --- writing -----------------------------------------------------------------------------------

  /**
   * Common write path for saves and MetaSave: game closed, unchanged since loading (hash), edit,
   * encrypt and verify, back up the current file, then replace it atomically.
   */
  async function writeChecked({ file, hash, edit, autoBackup, backup }) {
    if (typeof hash !== 'string') throw appError(400, 'input.hash');
    await requireGameClosed();
    const buf = readSaveFile(file);
    if (hash !== sha1(buf)) throw changedError();
    const save = es3Files.readSave(buf);
    const out = encodeChecked(edit(save.json), save, es3Files);
    const backupName = autoBackup === false ? null : backup();
    writeAtomic(file, out, hash);
    return { ok: true, backup: backupName, hash: sha1(out) };
  }

  /**
   * Restores a backup file: like every write only if the current file is still the version that was
   * loaded (hash); the backup is validated, the current file backed up first, then replaced.
   */
  async function restoreFrom(src, target, hash, backup) {
    if (typeof hash !== 'string') throw appError(400, 'input.hash');
    await requireGameClosed();
    if (!fs.existsSync(src)) throw appError(404, 'backup.notFound');
    if (hash !== sha1(readSaveFile(target))) throw changedError();
    const data = readSaveFile(src);
    es3Files.readSave(data); // refuses broken files
    const backupName = backup();
    writeAtomic(target, data, hash);
    return { ok: true, backup: backupName };
  }

  // --- MetaSave (cosmetics) ----------------------------------------------------------------------

  function readMeta() {
    if (!fs.existsSync(META_FILE)) throw appError(404, 'meta.notFound');
    const buf = readSaveFile(META_FILE);
    const save = es3Files.readSave(buf);
    if (!save.json.cosmeticUnlocks || !Array.isArray(save.json.cosmeticUnlocks.value)) throw appError(422, 'meta.format');
    return { buf, save };
  }
  function metaSummary(json) {
    const ints = k => (json[k] && Array.isArray(json[k].value) ? json[k].value.filter(Number.isInteger) : []);
    return { unlocks: ints('cosmeticUnlocks'), equipped: ints('cosmeticEquipped').filter(id => id >= 0), tokens: ints('cosmeticTokens').length };
  }
  /** Unlocked cosmetics the editor knows, matching "x of 547" in the UI (unknown ids are kept, not counted). */
  const knownUnlocked = json => new Set(metaSummary(json).unlocks.filter(id => id >= 0 && id < cosmetics.list.length)).size;
  function listMetaBackups() {
    const out = [];
    const summary = file => {
      const st = fs.statSync(file);
      try { return { ok: true, mtime: st.mtimeMs, unlocked: knownUnlocked(es3Files.readSave(readSaveFile(file)).json) }; } catch { return { ok: false, mtime: st.mtimeMs, unlocked: null }; }
    };
    if (fs.existsSync(META_BACKUPS)) {
      for (const f of fs.readdirSync(META_BACKUPS).filter(name => FILE_NAME.test(name))) {
        out.push(Object.assign({ source: 'editor', file: f, reason: reasonOf(f) }, summary(path.join(META_BACKUPS, f))));
      }
    }
    if (fs.existsSync(META_BAK)) out.push(Object.assign({ source: 'game', file: path.basename(META_BAK), reason: 'game' }, summary(META_BAK)));
    return out.sort(byNewest);
  }

  /**
   * Cosmetic ids are positions in the game's list. With the list read from the game they always match;
   * with the built-in list (written for TESTED_BUILD) they may not after a game update. Then the
   * editor only adds unlocks and never takes one back.
   */
  function cosmeticsLockable() {
    if (cosmetics.source === 'game') return true;
    const installed = readSteamBuild(GAME_DIR);
    return !installed || !installed.build || installed.build === TESTED_BUILD;
  }

  /**
   * New unlock list. Known ids (inside the editor's cosmetic list) follow the request; ids the
   * editor does not know (e.g. from a newer game version) and equipped cosmetics are always kept.
   * The game's order is kept, new ids are appended in ascending order.
   */
  function nextUnlocks(json, requested) {
    const max = cosmetics.list.length;
    if (!max) throw appError(500, 'cosmetics.missing');
    const known = id => id >= 0 && id < max;
    const want = new Set(requested.filter(id => Number.isInteger(id) && known(id)));
    const { unlocks, equipped } = metaSummary(json);
    equipped.forEach(id => want.add(id));
    const kept = cosmeticsLockable() ? unlocks.filter(id => !known(id) || want.has(id)) : unlocks.slice();
    const added = [...want].filter(id => !unlocks.includes(id)).sort((a, b) => a - b);
    return kept.concat(added);
  }

  // --- profiles ----------------------------------------------------------------------------------

  function readProfiles() {
    const list = readJson(PROFILES_FILE, []);
    return Array.isArray(list) ? list : [];
  }
  const runKeys = new Set(RUN_FIELDS.map(f => f.key));
  function cleanProfile(p) {
    p = p && typeof p === 'object' ? p : {};
    return {
      id: /^[A-Za-z0-9_-]{1,64}$/.test(p.id || '') ? p.id : crypto.randomUUID(),
      name: String(p.name || 'Profile').slice(0, LIMITS.profileName),
      run: cleanNumberMap(p.run, k => runKeys.has(k), 99999999),
      upgrades: cleanNumberMap(p.upgrades, k => /^playerUpgrade[A-Za-z]{1,40}$/.test(k), LIMITS.upgradeLevel),
      inv: cleanNumberMap(p.inv, k => ITEM_KEY.test(k), LIMITS.itemCount)
    };
  }

  // --- settings ----------------------------------------------------------------------------------

  const DEFAULT_SETTINGS = { autoBackup: true, language: null };
  /** Known settings only, with their defaults; a missing or broken file gives the defaults. */
  function readSettings() {
    const stored = readJson(SETTINGS_FILE) || {};
    return {
      autoBackup: typeof stored.autoBackup === 'boolean' ? stored.autoBackup : DEFAULT_SETTINGS.autoBackup,
      language: LANGUAGES.includes(stored.language) ? stored.language : DEFAULT_SETTINGS.language
    };
  }

  // --- routes ------------------------------------------------------------------------------------
  // GET routes must stay free of side effects; write operations are POST.

  const routes = {
    'GET /api/state': async () => ({
      appVersion: opts.appVersion || pkg.version,
      author: pkg.author || null,
      pathAliases,
      savesDir: SAVES_DIR,
      savesDirExists: fs.existsSync(SAVES_DIR),
      metaFile: META_FILE,
      backupDir: BACKUP_DIR,
      metaBackupDir: META_BACKUPS,
      backupReasons: REASON, // part of the backup file names
      configFile: opts.configFile || null,
      gameDir: GAME_DIR,
      game: Object.assign({ testedBuild: TESTED_BUILD }, readSteamBuild(GAME_DIR) || {}),
      gameRunning: await isGameRunning(),
      catalog,
      cosmetics,
      cosmeticsLockable: cosmeticsLockable(),
      limits: LIMITS,
      settings: readSettings(),
      password: passwordState()
    }),

    'POST /api/settings': async (q, body) => {
      const next = readSettings();
      if (typeof body.autoBackup === 'boolean') next.autoBackup = body.autoBackup;
      if (LANGUAGES.includes(body.language) || body.language === null) next.language = body.language;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      writeAtomic(SETTINGS_FILE, Buffer.from(JSON.stringify(next, null, 2)));
      return next;
    },

    'GET /api/status': async () => ({ gameRunning: await isGameRunning() }),

    'GET /api/saves': async (q, body, ctx) => listSaves(ctx.lang),

    // "Refresh list": also backs up saves that appeared since the start
    'POST /api/rescan': async (q, body, ctx) => {
      const made = backupOriginals();
      return { saves: listSaves(ctx.lang), savesDirExists: fs.existsSync(SAVES_DIR), metaExists: fs.existsSync(META_FILE), made, password: passwordState() };
    },

    'GET /api/save': async q => {
      const file = mainFile(q.id);
      const buf = readSaveFile(file);
      const { json } = es3Files.readSave(buf);
      const time = es3Value(json, 'timePlayed', 0);
      return {
        id: q.id,
        file,
        hash: sha1(buf),
        model: toModel(json),
        info: {
          timePlayed: typeof time === 'number' ? time : 0,
          date: String(es3Value(json, 'dateAndTime', '') || ''),
          saveVersion: Number.isFinite(es3Value(json, 'saveVersion', null)) ? es3Value(json, 'saveVersion', null) : null
        }
      };
    },

    'POST /api/save': async (q, body) => writeChecked({
      file: mainFile(q.id),
      hash: body.hash,
      edit: json => applyModel(json, plainObject(body.model)),
      autoBackup: body.autoBackup,
      backup: () => makeBackup(q.id, REASON.beforeSave)
    }),

    // Copy a save into a new slot (folder name = creation time, like the game does).
    'POST /api/duplicate': async (q, body) => {
      await requireGameClosed();
      const save = es3Files.readSave(readSaveFile(mainFile(q.id)));
      const team = String(body.team || '').trim().slice(0, LIMITS.teamName);
      if (team && save.json.teamName && save.json.teamName.value !== team) {
        save.json.teamName.value = team;
        if (save.json.teamNameChanged) save.json.teamNameChanged.value = true;
      }
      const out = encodeChecked(save.json, save, es3Files);
      const d = Date.now();
      for (let i = 0; i < SLOT_TRIES; i++) {
        const t = new Date(d + i * 1000);
        const id = 'REPO_SAVE_' + [t.getFullYear(), pad(t.getMonth() + 1), pad(t.getDate()), pad(t.getHours()), pad(t.getMinutes()), pad(t.getSeconds())].join('_');
        try {
          fs.mkdirSync(path.join(SAVES_DIR, id)); // fails if the slot exists
        } catch (e) {
          if (e.code === 'EEXIST') continue;
          throw e;
        }
        fs.writeFileSync(path.join(SAVES_DIR, id, id + '.es3'), out, { flag: 'wx' });
        makeBackup(id, REASON.original);
        return { ok: true, id };
      }
      throw appError(500, 'save.noFreeName');
    },

    'GET /api/backups': async (q, body, ctx) => listBackups(q.id, ctx.lang),

    'GET /api/backup-model': async q => {
      const file = backupPath(q.id, q.source, q.file);
      if (!fs.existsSync(file)) throw appError(404, 'backup.notFound');
      return { model: toModel(es3Files.readSave(readSaveFile(file)).json) };
    },

    'POST /api/backup': async q => ({ ok: true, backup: makeBackup(q.id, REASON.manual) }),

    'POST /api/restore': async (q, body) =>
      restoreFrom(backupPath(q.id, body.source, body.file), mainFile(q.id), body.hash, () => makeBackup(q.id, REASON.beforeRestore)),

    // Expert mode: the whole save as JSON text.
    'GET /api/raw': async q => {
      const buf = readSaveFile(mainFile(q.id));
      return { hash: sha1(buf), text: JSON.stringify(es3Files.readSave(buf).json, null, 2) };
    },

    'POST /api/raw': async (q, body) => {
      let json;
      try {
        json = es3.parseJson(String(body.text || ''));
      } catch (e) {
        // coded errors (e.g. numbers JavaScript cannot hold) keep their message; JSON.parse text is English
        throw e.code ? appError(400, e.code, e.params) : appError(400, 'input.json', { detail: e.message });
      }
      try {
        toModel(json); // must still be a readable save
      } catch (e) {
        throw e.code ? appError(400, e.code, e.params) : e;
      }
      return writeChecked({
        file: mainFile(q.id),
        hash: body.hash,
        edit: current => { checkSameStructure(current, json); return json; },
        autoBackup: body.autoBackup,
        backup: () => makeBackup(q.id, REASON.beforeSave)
      });
    },

    'GET /api/meta': async () => {
      const { buf, save } = readMeta();
      return Object.assign({ file: META_FILE, hash: sha1(buf) }, metaSummary(save.json));
    },

    'POST /api/meta': async (q, body) => {
      if (!Array.isArray(body.unlocks) || body.unlocks.length > MAX_UNLOCKS) throw appError(400, 'input.unlocks');
      readMeta(); // format check before anything else
      const result = await writeChecked({
        file: META_FILE,
        hash: body.hash,
        edit: json => { json.cosmeticUnlocks.value = nextUnlocks(json, body.unlocks); return json; },
        autoBackup: body.autoBackup,
        backup: () => makeMetaBackup(REASON.beforeSave)
      });
      return Object.assign(result, { unlocked: knownUnlocked(readMeta().save.json) });
    },

    'GET /api/meta-backups': async () => listMetaBackups(),

    'POST /api/meta-restore': async (q, body) => {
      const file = String(body.file || '');
      let src;
      if (body.source === 'editor' && FILE_NAME.test(file)) src = path.join(META_BACKUPS, file);
      else if (body.source === 'game' && file === path.basename(META_BAK)) src = META_BAK;
      else throw appError(400, 'input.backup');
      return restoreFrom(src, META_FILE, body.hash, () => makeMetaBackup(REASON.beforeRestore));
    },

    'GET /api/profiles': async () => readProfiles().map(cleanProfile),

    'POST /api/profiles': async (q, body) => {
      if (!Array.isArray(body.profiles) || body.profiles.length > MAX_PROFILES) throw appError(400, 'input.profiles');
      const clean = body.profiles.map(cleanProfile);
      fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
      writeAtomic(PROFILES_FILE, Buffer.from(JSON.stringify(clean, null, 2)));
      return clean;
    },

    // Opens a folder in Explorer. Targets come only from validated ids, never from paths.
    'POST /api/open': async (q, body) => {
      let target;
      if (body.what === 'backups') target = q.id ? backupDirFor(q.id) : BACKUP_DIR;
      else if (body.what === 'meta-backups') target = META_BACKUPS;
      else if (body.what === 'saves') target = q.id ? saveDir(q.id) : SAVES_DIR;
      else throw appError(400, 'input.folder');
      if (target.startsWith(BACKUP_DIR)) fs.mkdirSync(target, { recursive: true }); // backup folders may not exist yet
      (opts.openFolder || (dir => spawn(EXPLORER, [dir], { detached: true, stdio: 'ignore' }).unref()))(target);
      return { ok: true };
    }
  };

  // --- HTTP --------------------------------------------------------------------------------------

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size <= MAX_BODY_BYTES) chunks.push(c);
        else if (size > DROP_BODY_BYTES) {
          // far too much: drop the connection instead of reading on
          reject(appError(413, 'request.tooLarge'));
          req.destroy();
        }
        // slightly too much: read to the end (discarding it), so the 413 answer reaches the client
      });
      req.on('end', () => {
        if (size > MAX_BODY_BYTES) return reject(appError(413, 'request.tooLarge'));
        if (!chunks.length) return resolve({});
        try { resolve(plainObject(JSON.parse(Buffer.concat(chunks).toString('utf8')))); } catch (e) { reject(e.status ? e : appError(400, 'request.invalid')); }
      });
      req.on('error', reject);
    });
  }

  /** Content-Security-Policy for index.html; the inline script is allowed by its hash only. */
  function pageHeaders(html) {
    const hashes = inlineScripts(html)
      .map(s => "'sha256-" + crypto.createHash('sha256').update(s.text, 'utf8').digest('base64') + "'");
    return {
      'Content-Security-Policy': "default-src 'none'; script-src " + hashes.join(' ') + "; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    };
  }

  let boundPort = null;

  // file system errors the user can do something about
  const FS_CODES = { EBUSY: 'fs.busy', EPERM: 'fs.denied', EACCES: 'fs.denied', ENOSPC: 'fs.noSpace', ENOENT: 'fs.notFound' };

  /** Turns errors into messages for the UI in its language; unexpected errors are logged. */
  function toClientError(e, lang) {
    if (e.status) return { status: e.status, message: maskPaths(errorText(e, lang)), reason: e.reason };
    log('Error: ' + (e.stack || e.message));
    return { status: 500, message: FS_CODES[e.code] ? message(lang, FS_CODES[e.code]) : maskPaths(e.message) };
  }

  async function handle(req, res) {
    // language of the page that asked (it sends X-REPO-Lang); used for messages
    const lang = normalize(req.headers['x-repo-lang']);
    /** Answers of the API, including every error text: always JSON, never read as HTML. */
    const sendJson = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin'
      });
      res.end(JSON.stringify(body));
    };
    /** The page and its fonts: files of the editor itself, never data from a request or an error. */
    const sendFile = (data, type, headers) => {
      res.writeHead(200, Object.assign({
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin'
      }, headers));
      res.end(data);
    };
    const deny = (status, code) => sendJson(status, { error: message(lang, code) });
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return deny(400, 'request.invalid'); }
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== '127.0.0.1:' + boundPort && host !== 'localhost:' + boundPort) return deny(403, 'request.forbidden');
      const origin = req.headers.origin;
      if (origin && origin !== 'http://127.0.0.1:' + boundPort && origin !== 'http://localhost:' + boundPort) return deny(403, 'request.forbidden');
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return deny(403, 'request.forbidden');

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // read on every request (one local page, small): edits to it show up without a restart
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        return sendFile(html, 'text/html; charset=utf-8', pageHeaders(html));
      }
      const font = req.method === 'GET' && url.pathname.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
      if (font) {
        const file = path.join(PUBLIC_DIR, 'fonts', font[1]);
        if (!fs.existsSync(file)) return deny(404, 'request.notFound');
        return sendFile(fs.readFileSync(file), 'font/woff2', { 'Cache-Control': 'max-age=86400' });
      }
      const handler = Object.prototype.hasOwnProperty.call(routes, req.method + ' ' + url.pathname) && routes[req.method + ' ' + url.pathname];
      if (!handler) return deny(404, 'request.notFound');
      if (!tokenOk(req.headers['x-repo-editor'])) return deny(403, 'request.forbidden');
      const body = req.method === 'POST' ? await readBody(req) : {};
      const q = Object.fromEntries(url.searchParams);
      sendJson(200, await handler(q, body, { lang }));
    } catch (e) {
      const { status, message: text, reason } = toClientError(e, lang);
      if (!res.destroyed) sendJson(status, reason ? { error: text, reason } : { error: text });
    }
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => { // last resort: never let one request take the editor down
      log('Request failed: ' + (e.stack || e.message));
      res.destroy();
    });
  });

  /** port 0 = any free port; otherwise tries up to `tries` ports upwards. Resolves with the URL incl. token. */
  function listen(port = 0, tries = 10) {
    return new Promise((resolve, reject) => {
      const attempt = (p, left) => {
        const onError = err => {
          server.removeListener('listening', onListening);
          if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && p !== 0 && left > 0) return attempt(p + 1, left - 1);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          boundPort = server.address().port;
          resolve({ port: boundPort, url: 'http://127.0.0.1:' + boundPort + '/#token=' + TOKEN });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, '127.0.0.1');
      };
      attempt(port, tries);
    });
  }

  return {
    listen,
    close: () => new Promise(r => server.close(r)),
    backupOriginals,
    settings: () => readSettings(), // e.g. the UI language for the app's own dialogs
    token: TOKEN,
    savesDir: SAVES_DIR,
    backupDir: BACKUP_DIR,
    catalog,
    cosmetics
  };
}

module.exports = { createEditor, maskPaths, inlineScripts };
