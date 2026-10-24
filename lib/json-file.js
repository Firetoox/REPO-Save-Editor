'use strict';
// The editor's small JSON files: settings, profiles, config.json and the caches of game lists.

const fs = require('fs');

/**
 * Parsed content of a JSON file, or `fallback` if the file is missing or not valid JSON.
 * @param {string} file
 * @param {*} [fallback]
 * @param {(e: Error) => void} [onBroken] hears about files that exist but cannot be read or parsed
 */
function readJson(file, fallback = null, onBroken = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (onBroken && e.code !== 'ENOENT') onBroken(e);
    return fallback;
  }
}

/** Writes a cache file; a read-only folder only means there is no cache (returns false). */
function writeJsonQuietly(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** A plain object (not an array or null), else {} – for files that must hold key/value settings. */
const asObject = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

module.exports = { readJson, writeJsonQuietly, asObject };
