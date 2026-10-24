'use strict';
// Shared test helpers: test files (synthetic or copies) and a running editor.

const fs = require('fs');
const os = require('os');
const path = require('path');
const es3 = require('../lib/es3');
const { createEditor } = require('../lib/server');
const { createFixtures, TEST_PASSWORD } = require('./fixtures');
const { findGameDir } = require('../lib/catalog');
const { findPassword } = require('../lib/password');

// The game's real data folder. Tests must never point there, not even through a link.
const REAL_DATA = /[\\/]LocalLow[\\/]semiwork[\\/]/i;

/** Resolves links for existing paths (or their nearest existing parent folder). */
function realPath(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync.native(cur), ...rest);
}

function usageExit(usage) {
  console.error(usage);
  process.exit(2);
}

/**
 * Test files from the command line (only COPIES are allowed), or synthetic ones in a temporary
 * folder that is removed when the process exits.
 * @param {string[]} args [savesDir, metaFile, workDir]
 * @param {string} usage shown when the arguments are incomplete or point at the real game data
 */
function testFiles(args, usage) {
  const [savesDir, metaFile, work] = args;
  if (!savesDir) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-editor-test-'));
    process.on('exit', () => {
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* still locked */ }
    });
    return withReader(Object.assign(createFixtures(tmp), { work: path.join(tmp, 'work'), synthetic: true, password: TEST_PASSWORD }));
  }
  if (!metaFile || !work) usageExit(usage);
  for (const p of [savesDir, metaFile, work]) {
    if (REAL_DATA.test(realPath(p) + path.sep)) usageExit('Real game data is off limits, use copies only.\n' + usage);
  }
  // copies of real files: the password comes from the installed game, as in the app
  const gameDir = findGameDir();
  const saveFiles = fs.readdirSync(savesDir).map(id => path.join(savesDir, id, id + '.es3')).filter(f => fs.existsSync(f));
  const found = findPassword({ gameDir, files: [metaFile].concat(saveFiles) });
  if (!found.password) usageExit('Password not found in the game files (' + found.reason + '). Is R.E.P.O. installed?');
  return withReader({ savesDir: path.resolve(savesDir), metaFile: path.resolve(metaFile), work: path.resolve(work), synthetic: false, gameDir, password: found.password });
}

/** Adds read(file): the decrypted JSON of an .es3 file, with the password of these test files. */
function withReader(files) {
  const codec = es3.codec(files.password);
  return Object.assign(files, { read: file => codec.readSave(fs.readFileSync(file)).json });
}

/**
 * Starts an editor on a free port. With synthetic files it uses the fake game folder (built-in
 * lists, test password found by the real search); the game always counts as closed.
 * @returns {Promise<{ editor, url: string, port: number, call: Function, ok: Function }>}
 */
async function startEditor(files, extra = {}) {
  const editor = createEditor(Object.assign({
    savesDir: files.savesDir,
    metaFile: files.metaFile,
    backupDir: path.join(files.work, 'backups'),
    dataDir: path.join(files.work, 'data'),
    gameDir: files.gameDir,
    skipGameCheck: true,
    appVersion: 'test'
  }, extra));
  const { url, port } = await editor.listen(0);
  const base = 'http://127.0.0.1:' + port;

  /** Request with the session token unless headers say otherwise; returns status, type and data. */
  async function call(method, p, body, headers) {
    const res = await fetch(base + p, {
      method,
      headers: Object.assign({ 'X-REPO-Editor': editor.token }, body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  }
  /** Like call(), but expects 200 and returns the data. */
  async function ok(method, p, body) {
    const r = await call(method, p, body);
    if (r.status !== 200) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(r.data));
    return r.data;
  }
  return { editor, url, port, call, ok };
}

module.exports = { testFiles, startEditor, REAL_DATA };
