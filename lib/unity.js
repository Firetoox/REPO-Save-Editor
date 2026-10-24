'use strict';
/**
 * Minimal reader for Unity SerializedFiles as shipped with R.E.P.O. (format version 22, no type
 * trees). Only what the editor needs: the object table, the list of external files and the headers
 * of MonoBehaviour / MonoScript objects. Read-only; game files are never modified.
 *
 * Header (big-endian):
 *   u32 metadataSize, u32 fileSize, u32 version, u32 dataOffset
 *   v9+:  u8 endianness (0 = little) + 3 reserved bytes
 *   v22+: u32 metadataSize, u64 fileSize, u64 dataOffset, u64 reserved   (replace the 32-bit fields)
 * Metadata (little-endian):
 *   cstring unityVersion, i32 targetPlatform, u8 enableTypeTree,
 *   i32 typeCount, types: i32 classID, u8 isStripped, i16 scriptTypeIndex,
 *                         [16-byte script hash if classID = 114], 16-byte type hash
 *   i32 objectCount, objects: align4, i64 pathID, i64 byteStart, u32 byteSize, i32 typeIndex
 *   i32 scriptCount, scripts: i32 fileIndex, align4, i64 localId
 *   i32 externalCount, externals: cstring (empty), 16-byte GUID, i32 type, cstring pathName
 * A PPtr (reference to another object) is i32 fileID (0 = same file, n = externals[n-1]) + i64 pathID.
 */

const fs = require('fs');

const CLASS_MONOBEHAVIOUR = 114;
const CLASS_MONOSCRIPT = 115;
const PPTR_SIZE = 12; // i32 fileID + i64 pathID
const HASH_SIZE = 16;
const MAX_STRING = 10000;

const align4 = p => (p + 3) & ~3;

/**
 * @param {string} file
 * @returns {{ buf: Buffer, objects: {pathID: bigint, start: number, size: number, classID: number}[],
 *             externals: string[], byPath: Map<bigint, object> }}
 */
function parseSerializedFile(file) {
  const buf = fs.readFileSync(file);
  let p = 0;
  p += 8; // metadataSize, fileSize (32-bit fields, superseded in v22)
  const version = buf.readUInt32BE(p); p += 4;
  p += 4; // dataOffset (32-bit, superseded in v22)
  if (version < 22) throw new Error('Unsupported Unity file version ' + version);
  const littleEndian = buf[p] === 0; p += 4;
  if (!littleEndian) throw new Error('Big-endian Unity files are not supported');
  p += 4 + 8; // metadataSize, fileSize (64-bit layout)
  const dataOffset = Number(buf.readBigUInt64BE(p)); p += 8;
  p += 8; // reserved

  const i32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const cstr = () => { const e = buf.indexOf(0, p); if (e < 0) throw new Error('Damaged Unity file'); const s = buf.toString('utf8', p, e); p = e + 1; return s; };

  cstr(); // unity version
  i32(); // target platform
  if (buf[p++] !== 0) throw new Error('Unity files with type trees are not supported');
  const typeCount = i32();
  const types = [];
  for (let i = 0; i < typeCount; i++) {
    const classID = i32();
    p += 1 + 2; // isStripped, scriptTypeIndex
    if (classID === CLASS_MONOBEHAVIOUR) p += HASH_SIZE; // script hash
    p += HASH_SIZE; // type hash
    types.push(classID);
  }
  const objCount = i32();
  const objects = [];
  for (let i = 0; i < objCount; i++) {
    p = align4(p);
    const pathID = buf.readBigInt64LE(p); p += 8;
    const start = dataOffset + Number(buf.readBigInt64LE(p)); p += 8;
    const size = u32();
    const classID = types[i32()];
    objects.push({ pathID, start, size, classID });
  }
  const scriptCount = i32();
  for (let i = 0; i < scriptCount; i++) { i32(); p = align4(p); p += 8; }
  const extCount = i32();
  const externals = [];
  for (let i = 0; i < extCount; i++) { cstr(); p += HASH_SIZE; i32(); externals.push(cstr()); }
  return { buf, objects, externals, byPath: new Map(objects.map(o => [o.pathID, o])) };
}

/** 1-based index of an external file as used in PPtr.fileID (0 = same file, -1 = not referenced). */
function externalIndex(sf, name) {
  const i = sf.externals.findIndex(e => e.toLowerCase().endsWith(name.toLowerCase()));
  return i < 0 ? -1 : i + 1;
}

/** Serialized string: i32 length + UTF-8 bytes, padded to 4 bytes. */
function readString(buf, p) {
  if (p < 0 || p + 4 > buf.length) throw new Error('String outside the file');
  const len = buf.readInt32LE(p);
  if (len < 0 || len > MAX_STRING || p + 4 + len > buf.length) throw new Error('Invalid string');
  return { s: buf.toString('utf8', p + 4, p + 4 + len), next: align4(p + 4 + len) };
}

/**
 * Header of a MonoBehaviour object: PPtr m_GameObject, u8 m_Enabled (+ padding), PPtr m_Script,
 * string m_Name; the script's own fields follow at `fieldsStart`.
 */
function monoBehaviour(sf, o) {
  const b = sf.buf;
  let p = o.start + PPTR_SIZE + 4; // skip m_GameObject and m_Enabled
  const scriptFile = b.readInt32LE(p);
  const scriptPath = b.readBigInt64LE(p + 4);
  p += PPTR_SIZE;
  const name = readString(b, p);
  return { scriptFile, scriptPath, name: name.s, fieldsStart: name.next, end: o.start + o.size };
}

/** Map of MonoScript class name -> pathID (MonoScript objects start with their m_Name). */
function monoScripts(sf) {
  const map = new Map();
  for (const o of sf.objects) if (o.classID === CLASS_MONOSCRIPT) map.set(readString(sf.buf, o.start).s, o.pathID);
  return map;
}

module.exports = { CLASS_MONOBEHAVIOUR, PPTR_SIZE, align4, parseSerializedFile, externalIndex, readString, monoBehaviour, monoScripts };
