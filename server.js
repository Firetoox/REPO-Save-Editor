'use strict';
// Runs the editor backend without the Windows app and opens it in the default browser.
// For development: `npm run serve` (uses your REAL saves unless you pass copies, see below).
//
//   node server.js [--port 4317] [--no-open] [--saves-dir DIR] [--meta-file FILE] [--backup-dir DIR]
//                  [--game-dir DIR] [--no-game] [--skip-game-check]
//
// Environment: REPO_EDITOR_PORT and the variables listed in lib/options.js.
// Local data (backups, profiles, caches, optional config.json) goes to .data/ (git-ignored).

const path = require('path');
const { spawn } = require('child_process');
const { createEditor } = require('./lib/server');
const { readConfig, resolveOptions } = require('./lib/options');

const argv = process.argv.slice(2);
const DATA_DIR = path.join(__dirname, '.data');
const configFile = path.join(DATA_DIR, 'config.json');
const config = readConfig(configFile, msg => console.error(msg));

const options = resolveOptions({ argv, config, defaults: { backupDir: path.join(DATA_DIR, 'backups') } });
const editor = createEditor(Object.assign(options, {
  dataDir: DATA_DIR,
  configFile,
  appVersion: require('./package.json').version,
  log: (...msg) => console.error(...msg)
}));

editor.listen(options.port).then(({ url }) => {
  let made = [];
  try { made = editor.backupOriginals(); } catch (e) { console.error('Original backup failed:', e.message); }
  console.log('');
  console.log('  REPO Save Editor running:  ' + url);
  console.log('  Saves:      ' + editor.savesDir);
  console.log('  Backups:    ' + editor.backupDir);
  console.log('  Item list:  ' + editor.catalog.items.filter(i => !i.disabled).length + ' items (' + editor.catalog.source + ')');
  if (made.length) console.log('  Originals backed up: ' + made.join(', '));
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  // Windows: "start" opens the default browser (the URL contains the session token).
  // cmd by full path: a bare name would also be looked up in the current folder.
  const cmd = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  if (!argv.includes('--no-open')) spawn(cmd, ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}).catch(err => {
  console.error('Server could not start:', err.message);
  process.exit(1);
});
