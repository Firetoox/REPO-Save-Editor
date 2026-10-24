'use strict';
/**
 * The Easy Save 3 password of R.E.P.O. is not part of the editor. The game's code
 * (REPO_Data/Managed/Assembly-CSharp.dll) contains it as a string literal. This module reads all
 * string literals of that .NET assembly (its "#US" heap) and tries each one on a real encrypted
 * file; the one that opens it is the password. So nothing about the password is hard-coded, and a
 * game update that changes it is picked up automatically.
 *
 * The result is cached as the string's position in the DLL (never the password itself), together
 * with the DLL's size and time, so later starts read just that one string.
 */

const fs = require('fs');
const path = require('path');
const es3 = require('./es3');
const { readJson, writeJsonQuietly } = require('./json-file');

const DLL_PATH = ['REPO_Data', 'Managed', 'Assembly-CSharp.dll'];
const MAX_DLL_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_CHARS = 512; // longer literals are messages or data, not passwords
const CACHE_VERSION = 'password-v1';
// PE/COFF layout (Microsoft PE format specification)
const MZ_SIGNATURE = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const PE_POINTER = 0x3c; // where the DOS header stores the offset of the PE header
const OPTIONAL_PE32 = 0x10b;
const OPTIONAL_PE32_PLUS = 0x20b;
const DIRECTORIES_PE32 = 96; // data directories start this far into the optional header
const DIRECTORIES_PE32_PLUS = 112;
const SECTION_HEADER_BYTES = 40;
const CLI_HEADER_DIRECTORY = 14; // index of the CLI (.NET) header in the PE data directories
const METADATA_SIGNATURE = 0x424a5342; // "BSJB"

/**
 * All string literals of a .NET assembly in file order.
 * Layout (ECMA-335): PE headers -> CLI header -> metadata root -> stream "#US"; each entry of the
 * heap is a compressed length, UTF-16LE text and one trailing flag byte.
 * @param {Buffer} buf the DLL
 * @returns {{ offset: number, text: string }[]} offset = position inside the #US heap
 */
function readUserStrings(buf) {
  const fail = what => { throw new Error('Not a readable .NET assembly (' + what + ')'); };
  const u16 = p => (p >= 0 && p + 2 <= buf.length ? buf.readUInt16LE(p) : fail('outside the file'));
  const u32 = p => (p >= 0 && p + 4 <= buf.length ? buf.readUInt32LE(p) : fail('outside the file'));
  if (u16(0) !== MZ_SIGNATURE) fail('no MZ header');
  const pe = u32(PE_POINTER);
  if (u32(pe) !== PE_SIGNATURE) fail('no PE header');
  const coff = pe + 4;
  const sectionCount = u16(coff + 2);
  const optionalSize = u16(coff + 16);
  const optional = coff + 20;
  const magic = u16(optional);
  if (magic !== OPTIONAL_PE32 && magic !== OPTIONAL_PE32_PLUS) fail('unknown optional header');
  const directories = optional + (magic === OPTIONAL_PE32_PLUS ? DIRECTORIES_PE32_PLUS : DIRECTORIES_PE32);
  const cliRva = u32(directories + CLI_HEADER_DIRECTORY * 8);
  if (!cliRva) fail('no CLI header');

  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = optional + optionalSize + i * SECTION_HEADER_BYTES;
    sections.push({ va: u32(s + 12), size: Math.max(u32(s + 8), u32(s + 16)), raw: u32(s + 20) });
  }
  const fileOffset = rva => {
    const s = sections.find(x => rva >= x.va && rva < x.va + x.size);
    return s ? rva - s.va + s.raw : fail('address outside the sections');
  };

  const metadata = fileOffset(u32(fileOffset(cliRva) + 8));
  if (u32(metadata) !== METADATA_SIGNATURE) fail('no metadata');
  let p = metadata + 16 + u32(metadata + 12); // skip the version string
  const streamCount = u16(p + 2);
  p += 4;
  let heap = null;
  for (let i = 0; i < streamCount; i++) {
    const offset = u32(p), size = u32(p + 4);
    let end = p + 8;
    while (end < buf.length && buf[end] !== 0) end++;
    const name = buf.toString('ascii', p + 8, end);
    p = (end + 4) & ~3; // names are 0-terminated and padded to 4 bytes
    if (name === '#US') heap = { start: metadata + offset, end: metadata + offset + size };
  }
  if (!heap || heap.end > buf.length) fail('no string heap');

  const strings = [];
  let q = heap.start + 1; // entry 0 is the empty string
  while (q < heap.end) {
    const { len, head } = compressedLength(buf, q);
    if (q + head + len > heap.end) break; // damaged tail: keep what was read
    if (len > 1) strings.push({ offset: q - heap.start, text: buf.toString('utf16le', q + head, q + head + len - 1) });
    q += head + Math.max(len, 1);
  }
  return strings;
}

/**
 * Length prefix of a heap entry (ECMA-335 II.23.2): 1 byte for 0-0x7F, 2 bytes (10xxxxxx) up to
 * 0x3FFF, 4 bytes (110xxxxx) above. `head` is the number of bytes the prefix takes.
 */
function compressedLength(buf, p) {
  const b = buf[p];
  if ((b & 0x80) === 0) return { len: b, head: 1 };
  if ((b & 0xc0) === 0x80) return { len: ((b & 0x3f) << 8) | buf[p + 1], head: 2 };
  return { len: ((b & 0x1f) << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3], head: 4 };
}

/** Encrypted files to test candidates on (smallest first: fastest to check fully). */
function probeFiles(files) {
  return files
    .filter(f => { try { return fs.statSync(f).size <= es3.MAX_FILE_BYTES; } catch { return false; } })
    .map(f => ({ file: f, buf: fs.readFileSync(f) }))
    .filter(p => es3.mayBeEncrypted(p.buf) && !p.buf.toString('utf8', 0, 64).trimStart().startsWith('{'))
    .sort((a, b) => a.buf.length - b.buf.length);
}

/** True if the password opens the file completely (not only its first block). */
function opens(buf, password) {
  try { return es3.decrypt(buf, password).encrypted; } catch { return false; }
}

/**
 * Finds the password in the installed game.
 * @param {object} o
 * @param {string|null} o.gameDir   the R.E.P.O. folder (null = not found)
 * @param {string[]} o.files        .es3 files that may be encrypted (saves, MetaSave.es3)
 * @param {string|null} [o.cacheFile]
 * @returns {{ password: string|null, reason?: 'noGame'|'noDll'|'noProbe'|'notFound' }}
 */
function findPassword({ gameDir, files, cacheFile = null }) {
  if (!gameDir) return { password: null, reason: 'noGame' };
  const dll = path.join(gameDir, ...DLL_PATH);
  let stat;
  try { stat = fs.statSync(dll); } catch { return { password: null, reason: 'noDll' }; }
  if (stat.size > MAX_DLL_BYTES) return { password: null, reason: 'noDll' };
  const probes = probeFiles(files);
  if (!probes.length) return { password: null, reason: 'noProbe' };
  const stamp = CACHE_VERSION + ':' + stat.size + '/' + Math.round(stat.mtimeMs);

  let strings;
  try { strings = readUserStrings(fs.readFileSync(dll)); } catch { return { password: null, reason: 'noDll' }; }
  const cached = readCache(cacheFile, stamp);
  const known = cached !== null && strings.find(s => s.offset === cached);
  const candidates = strings.filter(s => s.text.length <= MAX_CANDIDATE_CHARS);

  // Each probe file in turn, so one damaged file (e.g. a half-written MetaSave.bak) does not hide
  // the password. Per file: the remembered position first, then every string literal.
  for (const { buf } of probes) {
    const works = text => es3.firstBlockOpens(buf, text) && opens(buf, text);
    const found = (known && works(known.text) && known) || candidates.find(s => works(s.text));
    if (found) {
      writeCache(cacheFile, stamp, found.offset);
      return { password: found.text };
    }
  }
  return { password: null, reason: 'notFound' };
}

function readCache(file, stamp) {
  const c = file && readJson(file);
  return c && c.stamp === stamp && Number.isInteger(c.offset) ? c.offset : null;
}

function writeCache(file, stamp, offset) {
  if (file) writeJsonQuietly(file, { stamp, offset });
}

module.exports = { readUserStrings, findPassword };
