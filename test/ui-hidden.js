'use strict';
// Drives the app invisibly (offscreen window, remote debugging); no window is ever shown.
//   node test/ui-hidden.js [--lang de|en] [--exe <packaged exe>] [--shots <folder>] [--with-game] [<savesDirCopy> <metaSaveCopy> <workDir>]
// Without paths it runs on synthetic test files (test/fixtures.js). With your own files: only COPIES.
// --shots   saves the README screenshots (synthetic data only; paths shown as the standard locations)
// --with-game  synthetic files: use the installed game (item and cosmetic lists) instead of the fake one;
//              copies of real files always use the installed game, which holds their password
// --lang       UI language for the run (default de); texts are checked through the page's own t()

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { test, before, after } = require('node:test');
const { testFiles } = require('./helpers');

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const opt = name => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const exeArg = opt('--exe');
const shotsDir = opt('--shots');
const withGame = flag('--with-game');
const lang = opt('--lang') || 'de';
if (!['de', 'en'].includes(lang)) { console.error('--lang de|en'); process.exit(2); }
const files = testFiles(argv, 'Only run with copies: node test/ui-hidden.js [--lang de|en] [--exe <exe>] [--with-game] <savesDirCopy> <metaSaveCopy> <workDir>');
if (shotsDir && !files.synthetic) { console.error('Screenshots only with synthetic test data (no real names in the docs).'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const exe = exeArg || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(files.work, { recursive: true });
// the stored language choice, as the app would have saved it
fs.mkdirSync(path.join(files.work, 'userdata'), { recursive: true });
fs.writeFileSync(path.join(files.work, 'userdata', 'settings.json'), JSON.stringify({ autoBackup: true, language: lang }));
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

/** Starts the app offscreen with remote debugging on a free port; resolves with the DevTools port. */
function launch() {
  const env = Object.assign({}, process.env, {
    REPO_EDITOR_HIDDEN: '1',
    REPO_EDITOR_SKIP_GAME_CHECK: '1',
    REPO_EDITOR_DATA_DIR: path.join(files.work, 'userdata'),
    REPO_SAVES_DIR: files.savesDir,
    REPO_META_FILE: files.metaFile,
    REPO_BACKUP_DIR: path.join(files.work, 'backups')
  });
  if (files.synthetic && !withGame) env.REPO_GAME_DIR = files.gameDir; // fake game with the test password
  if (shotsDir) env.REPO_EDITOR_DEMO_PATHS = '1';
  const args = (exeArg ? [] : [ROOT]).concat(['--remote-debugging-port=0']);
  const child = spawn(exe, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const port = new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error('app does not start: ' + err.slice(0, 300))), 30000);
    child.stderr.on('data', d => {
      err += d;
      const m = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('app exited (' + code + '): ' + err.slice(0, 300))); });
  });
  return { child, port };
}

// One app for all steps. The steps run in order and build on each other (a save written in one
// step is read in the next), as a user would go through the editor.
let child, ws;
let seq = 0;
const pending = new Map();
const errors = [];
/** Sends a DevTools protocol command and waits for its answer. */
const cdp = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
/** Runs an async function body in the page and returns its result. */
const js = async expr => {
  const r = await cdp('Runtime.evaluate', { expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : 'JS error');
  return r.result.result.value;
};
/** Waits until the page expression `cond` is true (up to 15 s). */
const until = async (cond, what) => {
  for (let i = 0; i < 75; i++) { if (await js('return !!(' + cond + ')')) return; await sleep(200); }
  throw new Error('timeout: ' + what);
};
const shot = async name => {
  if (!shotsDir) return;
  await js('if (S.toast) { S.toast = null; render(); } window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); return true');
  await sleep(200); // let fonts and layout settle before the picture
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
};
const click = sel => js('const el = document.querySelector(' + JSON.stringify(sel) + '); if (!el) throw new Error("missing: " + ' + JSON.stringify(sel) + '); if (el.disabled) throw new Error("disabled: " + ' + JSON.stringify(sel) + '); el.click(); return true');
const text = () => js('return document.body.innerText');
const saveFile = id => path.join(files.savesDir, id, id + '.es3');

before(async () => {
  const app = launch();
  child = app.child;
  const port = await app.port;
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{48}$/.test(t.url)); } catch { /* not up yet */ }
  }
  if (!target) throw new Error('editor page not found');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text); // e.g. CSP violations
  };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Log.enable');
});

after(async () => {
  try { if (ws) ws.close(); } catch { /* already closed */ }
  if (child) child.kill();
  await sleep(800); // let the app release its files before the temp folder is removed
});

let id;
let removed = null; // item taken out of the truck in the items step
test('Start: save and cosmetics loaded', async () => {
  await until('typeof S !== "undefined" && S.edit && S.meta', 'loading');
  id = await js('return S.saveId');
  if (await js('return S.lang + document.documentElement.lang') !== lang + lang) throw new Error('language is not ' + lang);
  if (files.synthetic && !/Demo Crew/.test(await text())) throw new Error('Demo Crew missing');
});

test('Translations: every text in German and English, same placeholders', async () => {
  const problems = await js(`const holes = s => (s.match(/\\{\\w+\\}/g) || []).sort().join();
    const bad = [];
    for (const [k, v] of Object.entries(TEXTS)) {
      if (!Array.isArray(v) || v.length !== 2) { bad.push(k + ': shape'); continue; }
      const [de, en] = v;
      if (Array.isArray(de) !== Array.isArray(en)) { bad.push(k + ': plural'); continue; }
      const pairs = Array.isArray(de) ? [[de[0], en[0]], [de[1], en[1]]] : [[de, en]];
      for (const [a, b] of pairs) if (!a || !b || holes(a) !== holes(b)) bad.push(k);
    }
    // every key the script asks for by name exists
    const code = [...document.querySelectorAll("script")].map(el => el.textContent).join(" ");
    for (const m of code.matchAll(/\\b(?:t|tp|tx)\\('([\\w.]*\\w)'\\s*[,)]/g)) if (!TEXTS[m[1]]) bad.push(m[1] + ': missing');
    return bad;`);
  if (problems.length) throw new Error(problems.join(', '));
});

if (shotsDir) {
  test('Picture: cosmetics in their initial state', async () => {
    await click('[data-act=view-cosmetics]');
    await until('S.meta && document.querySelectorAll(".coscard").length > 100', 'cosmetics');
    await shot('cosmetics');
    await click('[data-act=select-save][data-id="' + id + '"]');
    await until('S.view === "save" && S.edit', 'back to the save');
  });
}

test('Run values: stepper, input, undo', async () => {
  await click('[data-act=run-add][data-k=level][data-add="1"]');
  await js('const el = document.querySelector("[data-num=\\"run:currency\\"]"); el.focus(); el.value = "1234"; el.dispatchEvent(new Event("change", { bubbles: true })); return true');
  const r = await js('return { n: changes().length, level: S.edit.run.level - S.loaded.model.run.level, money: S.edit.run.currency, focus: document.activeElement.dataset.fk }');
  if (r.n !== 2 || r.level !== 1 || r.money !== 1234) throw new Error(JSON.stringify(r));
  if (r.focus !== 'run:currency') throw new Error('focus lost: ' + r.focus);
  await js('const el = document.querySelector("[data-num=\\"run:lives\\"]"); el.value = ""; el.dispatchEvent(new Event("change", { bubbles: true })); return true');
  if (await js('return S.edit.run.lives !== S.loaded.model.run.lives')) throw new Error('an empty input changed the value');
  await shot('overview');
  await click('[data-act=undo][data-i="0"]');
  await click('[data-act=undo][data-i="0"]');
  if (await js('return changes().length')) throw new Error('undo incomplete');
});

test('Typing a number and clicking a button right away: both apply', async () => {
  // real mouse input: the number is applied on blur, the click on "+" must not get lost
  const level = await js('return S.edit.run.level');
  await js('const el = document.querySelector("[data-num=\\"run:currency\\"]"); el.focus(); el.select(); return true');
  await cdp('Input.insertText', { text: '777' });
  await until('document.activeElement && document.activeElement.value === "777"', 'typed text in the field'); // CDP input is asynchronous
  const at = await js('const b = document.querySelector("[data-act=run-add][data-k=level][data-add=\\"1\\"]").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }');
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  try {
    await until('S.edit.run.currency === 777 && S.edit.run.level === ' + (level + 1), 'typed number and click both applied');
  } catch (e) {
    const now = await js('return { money: S.edit.run.currency, level: S.edit.run.level }');
    throw new Error(e.message + ': ' + JSON.stringify(now) + ', level before ' + level, { cause: e });
  }
  await js('S.edit = clone(S.loaded.model); render(); return true');
});

test('Players: notice, crown moves, full heal', async () => {
  await click('[data-tab=players]');
  if (!await js('return document.body.innerText.includes(t("players.multi"))')) throw new Error('notice missing');
  await shot('players');
  const second = await js('return S.edit.players[1] && S.edit.players[1].id');
  if (!second) return; // save with one player
  await click('[data-act=player][data-id="' + second + '"]');
  await js('const el = document.querySelector("[data-check=crown]"); el.click(); return true');
  if (await js('return !!document.querySelector("[data-act=hp-full]")')) {
    await click('[data-act=hp-full]');
    const hp = await js('const p = selPlayer(); return { hp: p.hp, want: Math.min(100 + 20 * (p.up.playerUpgradeHealth || 0), S.server.limits.hp) }');
    if (hp.hp !== hp.want) throw new Error('full heal: ' + JSON.stringify(hp));
  }
  const crowns = await js('return S.edit.players.filter(p => p.crown).map(p => p.id)');
  if (crowns.length !== 1 || crowns[0] !== second) throw new Error('crown: ' + JSON.stringify(crowns));
});

test('Items: list, remove, add', async () => {
  await click('[data-tab=items]');
  if (!(await js('return document.querySelectorAll(".itemcard").length') > 50)) throw new Error('item list missing');
  const owned = await js('return Object.keys(S.edit.inv).find(k => S.edit.inv[k] === 1)');
  if (owned) await click('[data-act=inv-add][data-key="' + owned + '"][data-add="-1"]');
  await js('S.items.q = "Sword"; render(); return true');
  await click('[data-act=inv-add][data-key="Item Melee Sword"][data-add="1"]');
  await js('S.items.q = ""; render(); return true');
  await shot('items');
  const r = await js('return { gone: ' + JSON.stringify(owned || '') + ' in S.edit.inv, sword: S.edit.inv["Item Melee Sword"] }');
  if ((owned && r.gone) || r.sword < 1) throw new Error(JSON.stringify(r));
  removed = owned || null;
});

test('Applying a profile creates changes', async () => {
  await click('[data-tab=profiles]');
  await click('[data-act=profile-apply][data-pid=b-up10]');
  if (!(await js('return changes().length') > 2)) throw new Error('no changes');
});

test('Save changes: the file holds exactly the changes', async () => {
  const expect = await js('return { team: S.edit.team, run: S.edit.run, crown: S.edit.players.filter(p => p.crown).map(p => p.id), up: S.edit.players.map(p => [p.id, p.up.playerUpgradeHealth]) }');
  const original = files.read(saveFile(id));
  await click('[data-act=open-write]');
  if (!await js('return !!document.activeElement.closest(".dialog")')) throw new Error('focus not in the dialog');
  await click('[data-act=confirm-write]');
  await until('S.toast && S.toast.text.startsWith(t("msg.written")) && S.edit && changes().length === 0', 'saving');
  const json = files.read(saveFile(id));
  const dd = json.dictionaryOfDictionaries.value;
  if (removed && removed in dd.itemsPurchased) throw new Error('removed item still there');
  if (dd.itemsPurchased['Item Melee Sword'] !== 1) throw new Error('sword missing');
  for (const [pid, lvl] of expect.up) if (dd.playerUpgradeHealth[pid] !== lvl) throw new Error('upgrade ' + pid);
  const crowns = Object.keys(dd.playerHasCrown).filter(k => dd.playerHasCrown[k]);
  if (expect.crown.length && JSON.stringify(crowns) !== JSON.stringify(expect.crown)) throw new Error('crown ' + crowns);
  if (json.teamName.value !== expect.team) throw new Error('team name');
  for (const [k, v] of Object.entries(expect.run)) if (dd.runStats[k] !== v) throw new Error('run value ' + k);
  // untouched parts stay exactly as they were
  for (const k of ['item', 'itemsPurchasedTotal', 'itemBatteryUpgrades']) {
    if (JSON.stringify(dd[k]) !== JSON.stringify(original.dictionaryOfDictionaries.value[k])) throw new Error(k + ' changed');
  }
  if (JSON.stringify(json.playerNames) !== JSON.stringify(original.playerNames)) throw new Error('playerNames changed');
});

test('Backups: compare a game backup', async () => {
  await click('[data-tab=backups]');
  await until('S.backups && S.backups.length', 'backups');
  const i = await js('const i = S.backups.findIndex(b => b.source === "game"); return i >= 0 ? i : S.backups.findIndex(b => b.ok)');
  await click('[data-act=compare][data-i="' + i + '"]');
  await until('S.modal && S.modal.type === "compare" && !S.modal.loading', 'comparison');
  if (!(await js('return S.modal.diff.length') > 0)) throw new Error('no differences');
  await shot('compare');
  await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return true');
  if (await js('return !!S.modal')) throw new Error('Escape does not close');
});

test('Duplicate', async () => {
  const saveCount = await js('return S.saves.length');
  await click('[data-act=open-duplicate]');
  await click('[data-act=confirm-duplicate]');
  await until('S.saves.length === ' + (saveCount + 1) + ' && S.edit && /\\((Kopie|copy)\\)$/.test(S.edit.team)', 'copy');
});

test('Expert mode: validation and lock on broken JSON', async () => {
  await click('[data-tab=raw]');
  await until('S.raw', 'raw data');
  await js('const t = document.getElementById("rawbox"); t.value = t.value + "x"; t.dispatchEvent(new Event("input", { bubbles: true })); return true');
  if (!await js('return document.getElementById("raw-status").textContent.startsWith(t("raw.invalid", { error: "" }))')) throw new Error('validation');
  if (!await js('return document.getElementById("raw-write").disabled')) throw new Error('saving not locked');
  await click('[data-act=raw-reload]');
  await click('[data-act=confirm-ok]');
  await until('S.raw && S.raw.text === S.raw.original', 'reload');
});

test('Security: HTML from the save is shown only as text', async () => {
  // the expert mode writes a team name, a player name and an item key with HTML
  const payload = '<img src=x onerror="window.__xss=1">';
  await js(`const j = JSON.parse(S.raw.text);
    j.teamName.value = ${JSON.stringify(payload)};
    const names = j.playerNames.value; const first = Object.keys(names)[0]; if (first) names[first] = ${JSON.stringify(payload)};
    j.dictionaryOfDictionaries.value.itemsPurchased[${JSON.stringify('Item ' + payload)}] = 1;
    S.raw.text = JSON.stringify(j, null, 2); render(); return true`);
  const oldHash = await js('return S.loaded.hash');
  await click('[data-act=raw-write]');
  await click('[data-act=confirm-raw]');
  // the success message comes before the reload, so wait for the reloaded save itself
  await until('S.loaded && S.loaded.hash !== ' + JSON.stringify(oldHash) + ' && S.edit && !S.busy', 'saving raw data');
  for (const tab of ['run', 'players', 'items']) { await click('[data-tab=' + tab + ']'); await until('S.tab === "' + tab + '"', tab); }
  await js('S.view = "save"; S.modal = { type: "write" }; render(); return true'); // dialog shows the team name too
  await until('document.querySelector(".dialog")', 'save dialog');
  const r = await js('S.modal = null; render(); return { xss: !!window.__xss, img: document.querySelectorAll("img").length, shown: document.body.innerText.includes("<img src=x") }');
  if (r.xss || r.img) throw new Error('HTML was executed: ' + JSON.stringify(r));
  if (!r.shown) throw new Error('name not visible as text');
});

test('Cosmetics: rarity and fixed color', async () => {
  await click('[data-act=view-cosmetics]');
  await until('S.meta && document.querySelectorAll(".coscard").length > 100', 'cosmetics');
  await click('[data-act=cos-rarity][data-rarity="3"]');
  const r = await js('const cards = [...document.querySelectorAll(".coscard")]; return { n: cards.length, ultra: cards.filter(c => c.innerText.includes("Ultra Rare")).length }');
  if (r.n !== 31 || r.ultra !== 31) throw new Error('Ultra Rare: ' + JSON.stringify(r));
  await click('[data-act=cos-rarity][data-rarity="all"]');
  const fixed = await js('return [...document.querySelectorAll(".coscard")].filter(c => c.innerText.includes(t("cos.fixed"))).length');
  if (fixed !== 73) throw new Error('fixed color: ' + fixed);
});

test('Cosmetics: lock, unlock, save; unknown ones stay', async () => {
  const unknownBefore = files.read(files.metaFile).cosmeticUnlocks.value.filter(i => i >= 547);
  const locked = await js('const ids = COS().map(c => c.id).filter(id => S.metaEdit.has(id) && !S.meta.equipped.includes(id)).slice(0, 3); ids.forEach(id => document.querySelector("[data-act=cos-toggle][data-cid=\\"" + id + "\\"]").click()); return ids.length');
  if (locked !== 3) throw new Error('nothing to lock');
  const unlocked = await js('return S.meta.unlocks.length');
  await click('[data-act=cos-open-write]');
  await click('[data-act=confirm-cos]');
  // the start of the message up to its number, in the language of the page
  const cosWritten = 'S.toast && S.toast.text.startsWith(TEXTS["msg.cosWritten"][langIndex()].split("{")[0])';
  await until(cosWritten + ' && S.meta.unlocks.length === ' + (unlocked - 3), 'saving locks');
  await click('[data-act=cos-all]');
  const expected = await js('return COS().filter(c => !S.meta.unlocks.includes(c.id)).length');
  if (await js('return metaChanges().length') !== expected) throw new Error('"unlock all" counts wrong');
  await click('[data-act=cos-open-write]');
  await click('[data-act=confirm-cos]');
  await until(cosWritten + ' && metaChanges().length === 0 && COS().every(c => S.meta.unlocks.includes(c.id))', 'saving unlocks');
  const saved = files.read(files.metaFile).cosmeticUnlocks.value;
  if (!unknownBefore.every(i => saved.includes(i))) throw new Error('unknown unlock lost');
});

test('Info dialog: copyright, focus returns after closing', async () => {
  await js('document.querySelector("[data-act=info]").focus(); return true');
  await click('[data-act=info]');
  const t = await js('return document.querySelector(".dialog").innerText');
  if (!/© 2026 .+ · MIT[- ]L(izenz|icense)/i.test(t)) throw new Error('copyright missing');
  if (!await js('return !!document.activeElement.closest(".dialog") && document.querySelector(".layout").inert')) throw new Error('dialog not modal');
  await click('[data-act=close-modal]');
  if (await js('return document.activeElement.dataset.act') !== 'info') throw new Error('focus not back');
});

test('The "automatic backup" switch is stored', async () => {
  const stored = 'return (await api("GET", "/api/state")).settings.autoBackup';
  await click('[data-check=autobackup]');
  await until('S.autoBackup === false', 'switch off');
  for (let i = 0; i < 20 && await js(stored) !== false; i++) await sleep(100);
  if (await js(stored) !== false) throw new Error('not stored');
  await click('[data-check=autobackup]');
  for (let i = 0; i < 20 && await js(stored) !== true; i++) await sleep(100);
  if (await js(stored) !== true) throw new Error('not switched on again');
});

test('Game state unknown: the top bar says so and saving is blocked', async () => {
  await click('[data-act=select-save][data-id="' + id + '"]');
  await until('S.edit && S.view === "save"', 'save');
  const r = await js(`S.server.gameRunning = null; S.edit.run.level++; S.modal = { type: "write" }; render();
    const out = { pill: document.body.innerText.includes(t("top.unknown")), note: document.body.innerText.includes(t("dlg.unknown")),
      locked: document.querySelector("[data-act=confirm-write]").disabled };
    S.modal = null; S.server.gameRunning = false; S.edit = clone(S.loaded.model); render();
    return out`);
  if (!r.pill || !r.note || !r.locked) throw new Error(JSON.stringify(r));
});

test('Switching language: English UI without German leftovers, choice is stored', async () => {
  await click('[data-act=lang][data-lang=en]');
  await until('S.lang === "en" && document.documentElement.lang === "en"', 'English');
  await js('S.toast = null; render(); return true'); // a message from before the switch keeps its language
  if (await js('return fmt(1234567)') !== '1,234,567') throw new Error('number format: ' + await js('return fmt(1234567)'));
  // typical German words, letters and quotes; the synthetic test data contains none of them
  const GERMAN_WORDS = [
    'und', 'Und', 'nicht', 'Nicht', 'oder', 'der', 'Der', 'die', 'Die', 'das', 'Das', 'dem', 'den', 'des',
    'ein', 'eine', 'einen', 'Ein', 'Eine', 'kein', 'keine', 'Kein', 'Keine', 'mit', 'Mit', 'für', 'Für',
    'von', 'vom', 'zum', 'zur', 'bei', 'auf', 'aus', 'nach', 'vor', 'wird', 'werden', 'wurde', 'ist', 'sind',
    'alle', 'Alle', 'Spiel', 'Spielstand', 'Spielstände', 'Spieler', 'Änderung', 'Änderungen', 'Kopie',
    'sichern', 'Sichern', 'speichern', 'Speichern', 'gespeichert', 'schreiben', 'Schreiben', 'geschrieben',
    'Ordner', 'Datei', 'Dateien', 'Datum', 'Geld', 'Leben', 'freigeschaltet', 'Krone', 'Stufe', 'vorher',
    'nachher', 'zurück', 'Hinweis', 'Einstellungen', 'Sprache', 'Fehler', 'Waffen', 'Seltenheit', 'Okt',
    'Dez', 'Mär', 'Mai', 'Juni', 'Juli'
  ];
  const german = '/[äöüßÄÖÜ„“]|\\b(' + GERMAN_WORDS.join('|') + ')\\b/';
  const leftovers = [];
  const scan = async where => {
    // All visible text plus tooltips, placeholders and labels. Not UI text: the expert textarea
    // (the save itself) and names from the saves (teams, players), e.g. "Demo Crew (Kopie)"
    // from the duplicate step of a German run.
    const found = await js(`const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, textarea").forEach(e => e.remove());
      const attrs = [...document.querySelectorAll("[title], [placeholder], [aria-label]")].map(e => [e.title, e.placeholder, e.getAttribute("aria-label")].filter(Boolean).join(" "));
      let text = clone.innerText + "\\n" + attrs.join("\\n");
      const names = [].concat(S.saves.map(s => s.team), (S.backups || []).map(b => b.team), S.edit ? [S.edit.team].concat(S.edit.players.map(p => p.name)) : [])
        .filter(n => typeof n === "string" && n.length > 1).sort((a, b) => b.length - a.length);
      for (const n of names) text = text.split(n).join(" ");
      const re = new RegExp(${german}.source, "g"), out = []; let m;
      while ((m = re.exec(text)) && out.length < 5) out.push(JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + 30)));
      return out`);
    if (found.length) leftovers.push(where + ': ' + found.join(', '));
  };
  const dialog = async (where, open) => {
    await js(open + '; render(); return true');
    await until('document.querySelector(".dialog")', 'dialog ' + where);
    await scan('dialog ' + where);
    await js('S.modal = null; render(); return true');
  };

  await click('[data-act=select-save][data-id="' + id + '"]');
  await until('S.edit && S.view === "save"', 'save');
  if (lang === 'de') {
    // the scanner itself: on the German page it must find German
    await js('setLanguage("de"); render(); return true');
    await scan('German self-check');
    if (!leftovers.length) throw new Error('scanner finds no German on the German page');
    leftovers.length = 0;
    await js('setLanguage("en"); render(); return true');
  }
  for (const tab of ['run', 'players', 'items', 'profiles', 'backups', 'raw']) {
    await click('[data-act=tab][data-tab=' + tab + ']');
    if (tab === 'backups') await until('S.backups && S.backups.length', 'backups');
    if (tab === 'raw') await until('S.raw', 'raw data');
    await until('S.tab === "' + tab + '"', tab);
    await scan(tab);
    if (tab === 'backups') {
      await dialog('restore', 'openModal({ type: "restore", backup: S.backups[0] })');
      await click('[data-act=compare][data-i="' + await js('return S.backups.findIndex(b => b.ok)') + '"]');
      await until('S.modal && S.modal.type === "compare" && !S.modal.loading', 'comparison');
      await scan('dialog compare');
      await js('S.modal = null; render(); return true');
    }
    if (tab === 'raw') {
      // edited raw data: status line, save dialog, "discard?" questions
      await js('S.raw.text = S.raw.text + " "; render(); return true');
      await scan('raw edited');
      await dialog('raw-write', 'openModal({ type: "raw-write" })');
      await dialog('guard raw', 'guardUnsaved("guard.discardTitle", "guard.discardSwitch", () => {})');
      await click('[data-act=raw-reload]');
      await scan('dialog raw-reload');
      await click('[data-act=confirm-ok]');
      await until('S.raw && S.raw.text === S.raw.original', 'reload');
    }
  }
  await click('[data-act=tab][data-tab=run]');
  // with changes, while the game "runs": change list, backup path, running note
  await js('S.edit.run.level++; S.edit.players.forEach(p => { p.crown = !p.crown; }); S.server.gameRunning = true; render(); return true');
  await scan('changes');
  await dialog('write', 'openModal({ type: "write" })');
  await dialog('write, game state unknown', 'S.server.gameRunning = null; openModal({ type: "write" })');
  await dialog('duplicate', 'ACTIONS["open-duplicate"]()');
  await dialog('profile-new', 'ACTIONS["profile-new"]()');
  await dialog('guard', 'guardUnsaved("guard.discardTitle", "guard.discardSwitch", () => {})');
  await js('S.server.gameRunning = false; S.edit = clone(S.loaded.model); render(); return true');
  await dialog('info', 'openModal({ type: "info" })');
  // banners for a missing password
  for (const reason of ['noGame', 'noDll', 'notFound']) {
    await js('window.__keepPw = S.server.password; S.server.password = { found: false, reason: ' + JSON.stringify(reason) + ' }; render(); return true');
    await scan('password ' + reason);
    await js('S.server.password = window.__keepPw; delete window.__keepPw; render(); return true');
  }
  await click('[data-act=view-cosmetics]');
  await until('S.meta && document.querySelectorAll(".coscard").length > 100', 'cosmetics');
  await scan('cosmetics');
  const cid = await js('return COS().find(c => !S.meta.equipped.includes(c.id)).id');
  await click('[data-act=cos-toggle][data-cid="' + cid + '"]');
  if (!await js('return metaChanges().length')) throw new Error('cosmetic toggle made no change');
  await scan('cosmetics with a change');
  await dialog('cos-write', 'openModal({ type: "cos-write" })');
  await dialog('cos-discard', 'ACTIONS["cos-discard"]()');
  await click('[data-act=cos-toggle][data-cid="' + cid + '"]');
  if (await js('return S.metaBackups && S.metaBackups.length')) await dialog('meta-restore', 'openModal({ type: "meta-restore", backup: S.metaBackups[0] })');
  // only with the synthetic data: real saves have team and player names in any language
  if (leftovers.length && files.synthetic) throw new Error('German in the English UI: ' + leftovers.join(' | '));
  const stored = await js('return (await api("GET", "/api/state")).settings.language');
  if (stored !== 'en') throw new Error('language not stored: ' + stored);
  // back to the language of this run
  await click('[data-act=lang][data-lang=' + lang + ']');
  await until('S.lang === ' + JSON.stringify(lang), 'back');
  if (lang === 'de' && await js('return !document.body.innerText.includes("Cosmetics gelten")')) throw new Error('German not back');
});

test('Password: read from the (fake) game file, notice when it is missing', async () => {
  if (!await js('return S.server.password.found')) throw new Error('password not found');
  // simulate a missing game: the banner explains what to do; with the password it is gone again
  const shown = await js('const keep = S.server.password; S.server.password = { found: false, reason: "noGame" }; render(); const ok = document.body.innerText.includes(t("pw.noGame")); S.server.password = keep; render(); return ok && !document.body.innerText.includes(t("pw.noGame"))');
  if (!shown) throw new Error('notice missing or stays');
});

test('No JavaScript or CSP errors', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
