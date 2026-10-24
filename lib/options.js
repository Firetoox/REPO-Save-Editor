'use strict';
// Editor options from command line, environment and config.json. Shared by the Windows app
// (electron/main.js) and the browser variant (server.js) so both behave the same.

const { readJson, asObject } = require('./json-file');

const DEFAULT_PORT = 4317; // server.js only; the app always takes a free port

/** Reads config.json; a missing file is normal, a broken one is reported through `log`. */
function readConfig(file, log) {
  return asObject(readJson(file, {}, e => log && log('config.json ignored: ' + e.message)));
}

/**
 * Precedence: command line > environment > config.json > defaults.
 * Command line: --saves-dir, --meta-file, --backup-dir, --game-dir, --no-game, --skip-game-check, --port
 * Environment:  REPO_SAVES_DIR, REPO_META_FILE, REPO_BACKUP_DIR, REPO_GAME_DIR, REPO_EDITOR_NO_GAME=1,
 *               REPO_EDITOR_PORT, REPO_EDITOR_SKIP_GAME_CHECK=1 and REPO_EDITOR_DEMO_PATHS=1 (tests and
 *               screenshots only)
 * @returns {{ savesDir?: string, metaFile?: string, backupDir: string, gameDir?: string|false,
 *             skipGameCheck: boolean, demoPaths: boolean, port: number }}
 */
function resolveOptions({ argv = [], env = process.env, config = {}, defaults = {} }) {
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const str = v => (typeof v === 'string' && v.trim() ? v : undefined);
  const noGame = argv.includes('--no-game') || env.REPO_EDITOR_NO_GAME === '1';
  const port = arg('--port') || str(env.REPO_EDITOR_PORT) || config.port; // 0 = any free port
  return {
    savesDir: str(arg('--saves-dir')) || str(env.REPO_SAVES_DIR) || str(config.savesDir),
    metaFile: str(arg('--meta-file')) || str(env.REPO_META_FILE) || str(config.metaFile),
    backupDir: str(arg('--backup-dir')) || str(env.REPO_BACKUP_DIR) || str(config.backupDir) || defaults.backupDir,
    // false = do not look for the game at all (tests that must not depend on the installed version)
    gameDir: noGame ? false : str(arg('--game-dir')) || str(env.REPO_GAME_DIR) || str(config.gameDir),
    skipGameCheck: argv.includes('--skip-game-check') || env.REPO_EDITOR_SKIP_GAME_CHECK === '1',
    demoPaths: env.REPO_EDITOR_DEMO_PATHS === '1',
    port: port === undefined ? DEFAULT_PORT : Number(port)
  };
}

module.exports = { readConfig, resolveOptions };
