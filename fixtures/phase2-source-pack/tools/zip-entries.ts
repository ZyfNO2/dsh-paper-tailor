/**
 * Minimal, dependency-free reader for the central directory of a ZIP archive.
 *
 * Why this exists
 * ---------------
 * The Phase 2 source pack pins one `offline_archive` source. Pinning only the archive
 * file's SHA-256 would leave its contents unverified, so every container entry is
 * recorded (name, sizes, CRC-32, SHA-256) and must be recomputed from the archive bytes.
 * Node has no ZIP API, so this reads the end-of-central-directory record, walks the
 * central directory, and inflates each entry with `node:zlib` (method 0 = stored,
 * method 8 = deflate). No third-party dependency is added.
 *
 * This is deliberately strict: any structural surprise throws rather than returning a
 * partial list, because a partial list would silently weaken the pin.
 */

import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';

export interface ZipEntryRecord {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  sha256: string;
  bytes: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function readZipEntries(buffer: Buffer): ZipEntryRecord[] {
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - MAX_COMMENT);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP_EOCD_NOT_FOUND: no end-of-central-directory record');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP_CENTRAL_DIRECTORY_OUT_OF_RANGE');
  }

  const entries: ZipEntryRecord[] = [];
  let cursor = centralOffset;

  for (let index = 0; index < totalEntries; index++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`ZIP_CENTRAL_DIRECTORY_CORRUPT at entry ${index}`);
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`ZIP_LOCAL_HEADER_CORRUPT for entry "${name}"`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (compressionMethod === 0) {
      data = Buffer.from(compressed);
    } else if (compressionMethod === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`ZIP_UNSUPPORTED_COMPRESSION method ${compressionMethod} for entry "${name}"`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(
        `ZIP_SIZE_MISMATCH for entry "${name}": central directory says ${uncompressedSize}, inflated ${data.length}`
      );
    }
    if (typeof zlib.crc32 === 'function') {
      const actualCrc = zlib.crc32(data) >>> 0;
      if (actualCrc !== crc32 >>> 0) {
        throw new Error(
          `ZIP_CRC_MISMATCH for entry "${name}": recorded ${(crc32 >>> 0).toString(16)}, computed ${actualCrc.toString(16)}`
        );
      }
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32: crc32 >>> 0,
      sha256: sha256Hex(data),
      bytes: data.length,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (cursor !== centralOffset + centralSize) {
    throw new Error('ZIP_CENTRAL_DIRECTORY_SIZE_MISMATCH: the central directory was not consumed exactly');
  }

  return entries;
}
