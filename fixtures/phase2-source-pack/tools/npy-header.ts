/**
 * Minimal reader for the `.npy` header (magic, version, dtype descriptor, shape, order).
 *
 * The data manifest claims a dtype and a shape per file. Comparing a file's recorded dtype and
 * shape against the SAME recorded values would prove nothing, so the verifier reads the real
 * header out of the bytes on disk and checks the claim against that. Node has no `.npy` API and
 * no third-party dependency is added, so this parses the documented header layout directly:
 *
 *   bytes 0..5   magic "\x93NUMPY"
 *   byte  6      major version, byte 7 minor version
 *   bytes 8..9   uint16 little-endian header length (v1.x)
 *   bytes 10..   ASCII Python literal dict, newline padded to a 64-byte boundary
 */

import * as fs from 'node:fs';

export interface NpyHeader {
  formatVersion: string;
  descriptor: string;
  fortranOrder: boolean;
  shape: number[];
}

const MAGIC = '\x93NUMPY';

export function readNpyHeader(absPath: string): NpyHeader {
  const bytes = fs.readFileSync(absPath);
  if (bytes.length < 10) throw new Error(`NPY_TOO_SHORT: ${absPath} is ${bytes.length} bytes`);
  const magic = bytes.subarray(0, 6).toString('latin1');
  if (magic !== MAGIC) throw new Error(`NPY_BAD_MAGIC: ${absPath} starts with ${JSON.stringify(magic)}`);

  const major = bytes[6];
  const minor = bytes[7];
  if (major !== 1) {
    throw new Error(`NPY_UNSUPPORTED_VERSION: ${absPath} is version ${major}.${minor}; only 1.x is parsed`);
  }
  const headerLength = bytes.readUInt16LE(8);
  const header = bytes.subarray(10, 10 + headerLength).toString('latin1');

  const descriptor = /'descr'\s*:\s*'([^']*)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];

  if (descriptor === undefined) throw new Error(`NPY_MISSING_DESCR: ${absPath}`);
  if (fortran === undefined) throw new Error(`NPY_MISSING_ORDER: ${absPath}`);
  if (shapeText === undefined) throw new Error(`NPY_MISSING_SHAPE: ${absPath}`);

  const shape = shapeText
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const value = Number(part);
      if (!Number.isInteger(value) || value < 0) throw new Error(`NPY_BAD_SHAPE_ENTRY: ${absPath} -> ${part}`);
      return value;
    });

  return {
    formatVersion: `${major}.${minor}`,
    descriptor,
    fortranOrder: fortran === 'True',
    shape,
  };
}

/** Maps a `.npy` dtype descriptor to the name the data manifest records. */
export function npyDtypeName(descriptor: string): string {
  const table: Record<string, string> = {
    '<f4': 'float32',
    '<f8': 'float64',
    '<i8': 'int64',
    '<i4': 'int32',
    '<u1': 'uint8',
    '|i1': 'int8',
    '|b1': 'bool',
  };
  return table[descriptor] ?? descriptor;
}
