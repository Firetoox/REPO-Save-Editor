'use strict';
// Windows app: starts the editor backend on a free local port and shows it in its own window.
//
// Test hooks (environment variables, used by test/ui-hidden.js; never needed in normal use):
//   REPO_EDITOR_HIDDEN=1      render offscreen, never show a window or dialog
//   REPO_EDITOR_DATA_DIR      separate data folder (profiles, caches, log, window size)
//   REPO_EDITOR_CAPTURE       save a screenshot of the loaded page to this file
//   plus the options in lib/options.js (REPO_SAVES_DIR, REPO_META_FILE, REPO_BACKUP_DIR, ...)

// Tests: an error while starting must end the app with a message on stderr, never with Electron's
// error dialog (that would be a visible window). Set first, before anything else can fail.
if (process.env.REPO_EDITOR_HIDDEN === '1') {
  process.on('uncaughtException', e => {
    console.error('Start failed: ' + (e && e.stack || e));
    process.exit(1);
  });
}

const { app, BrowserWindow, Menu, dialog, screen, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { createEditor, maskPaths } = require('../lib/server');
const { readConfig, resolveOptions } = require('../lib/options');
const { message } = require('../lib/messages');

// Taskbar grouping and notifications. Must equal build.appId in package.json; written out here
// because the package.json inside the installed app has no "build" section (test/unit.js checks it).
app.setAppUserModelId('de.reposaveeditor.app');
if (process.env.REPO_EDITOR_DATA_DIR) app.setPath('userData', process.env.REPO_EDITOR_DATA_DIR);

const HIDDEN = process.env.REPO_EDITOR_HIDDEN === '1';
const DEFAULT_SIZE = { width: 1440, height: 940 };
const MIN_SIZE = { width: 960, height: 620 };
const VISIBLE_MARGIN = 100; // at least this much of a restored window must be on screen
const TITLE_BAR_SLACK = 20; // a window may sit this far above the work area and still be draggable
const CAPTURE_DELAY_MS = 3000;

let win = null;
let logFile = null;
let editor = null;

/** Language of the app's own dialogs: the one chosen in the editor, otherwise the system language. */
function language() {
  const chosen = editor && editor.settings().language;
  return chosen || (app.getLocale().toLowerCase().startsWith('de') ? 'de' : 'en');
}
const text = code => message(language(), code);

/** main.log may end up in bug reports, so the user folder is written as %USERPROFILE%. */
function log(...parts) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + maskPaths(parts.join(' ')) + '\n'); } catch { /* no log */ }
}

/** Last window size/position, used only if it still fits a connected screen. */
function loadBounds(file) {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.max(MIN_SIZE.width, Math.min(b.width, area.width));
    const height = Math.max(MIN_SIZE.height, Math.min(b.height, area.height));
    const visible = b.x < area.x + area.width - VISIBLE_MARGIN && b.x + width > area.x + VISIBLE_MARGIN &&
      b.y >= area.y - TITLE_BAR_SLACK && b.y < area.y + area.height - VISIBLE_MARGIN; // the title bar must be reachable
    return { x: visible ? b.x : undefined, y: visible ? b.y : undefined, width, height, maximized: b.maximized === true };
  } catch {
    return null;
  }
}

/** The page may not ask for camera, microphone, location, notifications or anything else. */
function denyPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function createWindow(url, userData) {
  const boundsFile = path.join(userData, 'window.json');
  const bounds = HIDDEN ? null : loadBounds(boundsFile);
  const origin = new URL(url).origin;

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    width: bounds ? bounds.width : DEFAULT_SIZE.width,
    height: bounds ? bounds.height : DEFAULT_SIZE.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    skipTaskbar: HIDDEN,
    title: 'REPO Save Editor',
    backgroundColor: '#111214',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: HIDDEN }
  });

  if (!HIDDEN) {
    // Remember size and maximized state; isMaximized() is unreliable while minimized, so track events.
    let maximized = !!(bounds && bounds.maximized);
    win.on('maximize', () => { maximized = true; });
    win.on('unmaximize', () => { maximized = false; });
    win.once('ready-to-show', () => {
      if (maximized) win.maximize();
      win.show();
    });
    win.on('close', () => {
      try { fs.writeFileSync(boundsFile, JSON.stringify(Object.assign(win.getNormalBounds(), { maximized }))); } catch { /* not critical */ }
    });
  }

  // The app only ever shows its own page: no new windows, no navigation elsewhere.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const stayHome = (e, legacyUrl) => {
    const target = e.url || legacyUrl || '';
    try { if (new URL(target).origin === origin) return; } catch { /* invalid URL */ }
    e.preventDefault();
  };
  win.webContents.on('will-navigate', stayHome);
  win.webContents.on('will-frame-navigate', stayHome);

  // The page vetoes unloading while there are unwritten changes. Ask the user; preventDefault()
  // here overrides the page's veto and the window closes.
  win.webContents.on('will-prevent-unload', e => {
    if (HIDDEN) { e.preventDefault(); return; } // tests: never show a dialog
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: text('app.unsaved.title'),
      message: text('app.unsaved.message'),
      detail: text('app.unsaved.detail'),
      buttons: [text('app.unsaved.discard'), text('app.unsaved.cancel')],
      defaultId: 1,
      cancelId: 1
    });
    if (choice === 0) e.preventDefault();
  });

  win.webContents.on('did-fail-load', (e, code, desc) => log('Load failed', code, desc));
  win.webContents.on('render-process-gone', (e, details) => log('Renderer gone', details.reason));

  if (process.env.REPO_EDITOR_CAPTURE) {
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      win.webContents.capturePage()
        .then(image => { fs.writeFileSync(process.env.REPO_EDITOR_CAPTURE, image.toPNG()); log('Screenshot saved'); })
        .catch(e => log('Screenshot failed:', e.message));
    }, CAPTURE_DELAY_MS));
  }

  return win.loadURL(url);
}

async function start() {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  logFile = path.join(userData, 'main.log');
  denyPermissions();

  const configFile = path.join(userData, 'config.json');
  const options = resolveOptions({
    argv: process.argv,
    config: readConfig(configFile, log),
    defaults: { backupDir: path.join(app.getPath('documents'), 'REPO Save Editor', 'Backups') }
  });
  editor = createEditor(Object.assign(options, { dataDir: userData, appVersion: app.getVersion(), configFile, log }));
  const { url } = await editor.listen(0);
  log('Start', app.getVersion(), 'port', new URL(url).port, 'items', editor.catalog.source, 'cosmetics', editor.cosmetics.source);
  if (editor.cosmetics.fallbackReason) log('Cosmetics not readable from the game files:', editor.cosmetics.fallbackReason);
  try {
    const made = editor.backupOriginals();
    if (made.length) log('Originals backed up:', made.length);
  } catch (e) {
    log('Original backup failed:', e.message);
  }
  await createWindow(url, userData);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start).catch(err => {
    log('Start failed:', err && err.stack);
    if (!HIDDEN) dialog.showErrorBox('REPO Save Editor', text('app.startFailed') + '\n' + (err && err.message));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
