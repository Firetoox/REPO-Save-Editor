'use strict';
// Small JSON cache for lists scanned from the game files. The stamp combines a format version with
// the sizes/times of the scanned files, so a game update or a changed scanner triggers a rescan.

const { readJson, writeJsonQuietly } = require('./json-file');

/**
 * @param {string|null} cacheFile where to keep the cache (null = no cache)
 * @param {string} stamp identifies the scanned files and the scanner version
 * @param {() => any} scan produces fresh data
 */
function loadCached(cacheFile, stamp, scan) {
  const cache = cacheFile && readJson(cacheFile); // none yet or unreadable: scan
  if (cache && cache.stamp === stamp) return cache.data;
  const data = scan();
  if (cacheFile) writeJsonQuietly(cacheFile, { stamp, data });
  return data;
}

module.exports = { loadCached };
