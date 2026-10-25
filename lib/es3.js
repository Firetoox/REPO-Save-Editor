'use strict';
/**
 * Easy Save 3 (.es3) files as written by R.E.P.O.
 *
 * Layout: [16-byte IV][AES-128-CBC ciphertext, PKCS#7 padding]
 * Key:    PBKDF2-HMAC-SHA1(password, salt = IV, 100 iterations, 16 bytes)
 * Inside: ES3's JSON text, optionally gzip-compressed. Every top-level key holds { "__type", "value" }.
 *
 * There is no MAC in the format; a wrong key or a damaged file shows up as a padding error.
 * The password is not part of the editor: lib/password.js reads it from the installed game, and
 * codec(password) binds these functions to it.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { appError } = require('./messages');

const IV_BYTES = 16; // = AES block size
const KEY_BYTES = 16; // AES-128
const KDF_ITERATIONS = 100; // Easy Save 3 default
const MAX_FILE_BYTES = 32 * 1024 * 1024; // real saves are a few KB; refuse absurd files early
const MAX_PLAIN_BYTES = 64 * 1024 * 1024; // limit for gunzip output (protects against zip bombs)
const GZIP_MAGIC = [0x1f, 0x8b];

function deriveKey(password, iv) {
  return crypto.pbkdf2Sync(password, iv, KDF_ITERATIONS, KEY_BYTES, 'sha1');
}

const looksLikeJson = text => text.trimStart().startsWith('{');
/** Text without a leading UTF-8 byte order mark (JSON.parse refuses it; ES3 itself writes none). */
const withoutBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
/** Size fits "IV + whole cipher blocks", so the file may be encrypted (plain JSON can fit too). */
const mayBeEncrypted = buf => buf.length >= IV_BYTES * 2 && (buf.length - IV_BYTES) % IV_BYTES === 0;

/**
 * Decrypts (or, for unencrypted files, just reads) an ES3 file.
 * @param {Buffer} buf file content
 * @param {string|null} password null = not known; then only unencrypted files can be read
 * @returns {{ text: string, encrypted: boolean, gzipped: boolean, iv: Buffer|null }}
 */
function decrypt(buf, password) {
  if (buf.length > MAX_FILE_BYTES) throw appError(413, 'file.tooLarge');
  // Try decryption first: a random IV can start with "{" too, so the first byte proves nothing.
  let reason = null;
  if (mayBeEncrypted(buf) && password) {
    try {
      const iv = Buffer.from(buf.subarray(0, IV_BYTES)); // copy, so the caller does not keep the whole file alive
      const decipher = crypto.createDecipheriv('aes-128-cbc', deriveKey(password, iv), iv);
      let data = Buffer.concat([decipher.update(buf.subarray(IV_BYTES)), decipher.final()]);
      const gzipped = data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1];
      if (gzipped) data = zlib.gunzipSync(data, { maxOutputLength: MAX_PLAIN_BYTES });
      const text = withoutBom(data.toString('utf8'));
      if (looksLikeJson(text)) return { text, encrypted: true, gzipped, iv };
      reason = 'notJson';
    } catch (e) {
      reason = e.code === 'ERR_BUFFER_TOO_LARGE' ? 'unpacked' : 'damaged';
    }
  }
  const plain = withoutBom(buf.toString('utf8'));
  if (looksLikeJson(plain)) return { text: plain, encrypted: false, gzipped: false, iv: null };
  if (!password && mayBeEncrypted(buf)) throw appError(422, 'es3.noPassword');
  throw appError(422, reason ? 'es3.invalid.' + reason : 'es3.invalid');
}

/**
 * Quick test whether `password` opens the encrypted file `buf`: only the first block is decrypted.
 * Used to pick the password among many candidates; confirm a match with decrypt().
 */
function firstBlockOpens(buf, password) {
  if (!mayBeEncrypted(buf)) return false;
  const iv = buf.subarray(0, IV_BYTES);
  const decipher = crypto.createDecipheriv('aes-128-cbc', deriveKey(password, iv), iv);
  decipher.setAutoPadding(false);
  const block = decipher.update(buf.subarray(IV_BYTES, IV_BYTES * 2));
  if (block[0] === GZIP_MAGIC[0] && block[1] === GZIP_MAGIC[1]) return true;
  // JSON text: optional whitespace, then "{", and no control characters besides tab and line breaks
  const start = block.findIndex(b => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
  return start >= 0 && block[start] === 0x7b && block.every(b => b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0d);
}

/**
 * Encrypts JSON text in the same flavour as the original file.
 * @param {string} text
 * @param {{ encrypted?: boolean, gzipped?: boolean, iv?: Buffer, password?: string|null }} [opts]
 *   iv only for tests; normally a fresh random IV
 * @returns {Buffer}
 */
function encrypt(text, opts = {}) {
  const { encrypted = true, gzipped = false, password = null } = opts;
  let data = Buffer.from(text, 'utf8');
  if (gzipped) data = zlib.gzipSync(data);
  if (!encrypted) return data;
  if (!password) throw appError(500, 'es3.noPassword');
  const iv = opts.iv || crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-128-cbc', deriveKey(password, iv), iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}

/**
 * JSON.parse that refuses numbers JavaScript cannot hold exactly. A silently rounded value would
 * be written back changed, so such files are rejected instead. Steam IDs (17 digits) are object
 * keys, i.e. strings, and are not affected.
 * @param {string} text
 */
function parseJson(text) {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++; // skip the escaped character
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if ((ch >= '0' && ch <= '9') || ch === '-') {
      let j = i;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      const token = text.slice(i, j);
      const n = Number(token);
      // Infinity (e.g. 1e400) and integers beyond 2^53 (also as 1.2e17 or 12345678901234567.0) would change
      if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
        throw appError(422, 'es3.unsafeNumber', { token: token.slice(0, 30) });
      }
      i = j - 1;
    }
  }
  return JSON.parse(text);
}

/**
 * Reads an .es3 file buffer into JSON and remembers its flavour for writing it back.
 * @returns {{ json: object, encrypted: boolean, gzipped: boolean }}
 */
function readSave(buf, password) {
  const dec = decrypt(buf, password);
  let json;
  try {
    json = parseJson(dec.text);
  } catch (e) {
    if (e.code) throw e; // e.g. numbers that cannot be kept exactly
    throw appError(422, 'es3.invalid.notJson');
  }
  return { json, encrypted: dec.encrypted, gzipped: dec.gzipped };
}

/**
 * Serialises JSON and encrypts it. Tab indentation is only for readability; Easy Save's JSON
 * reader accepts any whitespace (confirmed: the game loads files written this way).
 * @param {object} json
 * @param {{ encrypted?: boolean, gzipped?: boolean, password?: string|null }} format
 */
function writeSave(json, format) {
  return encrypt(JSON.stringify(json, null, '\t'), format);
}

/**
 * The file functions bound to one password.
 * @param {string|null|(() => string|null)} password the password, or a function that returns it
 *   (the server resolves it lazily from the game files)
 */
function codec(password) {
  const get = typeof password === 'function' ? password : () => password;
  return {
    decrypt: buf => decrypt(buf, get()),
    encrypt: (text, opts = {}) => encrypt(text, Object.assign({}, opts, { password: get() })),
    readSave: buf => readSave(buf, get()),
    writeSave: (json, format = {}) => writeSave(json, Object.assign({}, format, { password: get() }))
  };
}

module.exports = { MAX_FILE_BYTES, codec, decrypt, encrypt, firstBlockOpens, mayBeEncrypted, parseJson, readSave, writeSave };
