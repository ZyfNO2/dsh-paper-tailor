import { createHash } from 'node:crypto';
import { KnowledgeError, sha256Hex, type ArtifactRef } from '../contracts/knowledge.ts';

export interface ParagraphChunk {
  paragraphIndex: number;
  rawByteStart: number;
  rawByteEndExclusive: number;
  normalizedStart: number;
  normalizedEnd: number;
  textHash: string;
  text: string;
}

function strictUtf8(bytes: Uint8Array, at: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new KnowledgeError('INVALID_UTF8', `${at} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`, [at]);
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Split only on blank lines, retaining raw UTF-8 byte locators and normalized offsets. */
export function splitParagraphs(bytes: Uint8Array, maxChunkBytes: number, sourceName: string): ParagraphChunk[] {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new KnowledgeError('INVALID_CONFIG', 'maxChunkBytes must be a positive integer');
  const source = strictUtf8(bytes, sourceName);
  const normalizedSource = normalizeNewlines(source);
  const rawOffsetByNormalizedOffset = new Array<number>(normalizedSource.length + 1);
  let normalizedOffset = 0;
  let rawOffset = 0;
  for (let i = 0; i < source.length;) {
    const cp = source.codePointAt(i);
    if (cp === undefined) throw new KnowledgeError('INVALID_UTF8', `${sourceName} contains an invalid code point`);
    const originalChar = String.fromCodePoint(cp);
    const originalSequence = originalChar === '\r' && source[i + 1] === '\n' ? '\r\n' : originalChar;
    const normalizedChar = originalChar === '\r' ? '\n' : originalChar;
    const charUnits = normalizedChar.length;
    for (let unit = 0; unit < charUnits; unit += 1) rawOffsetByNormalizedOffset[normalizedOffset + unit] = rawOffset;
    normalizedOffset += charUnits;
    rawOffset += Buffer.byteLength(originalSequence, 'utf8');
    rawOffsetByNormalizedOffset[normalizedOffset] = rawOffset;
    i += originalSequence.length;
  }
  const spans: Array<{ start: number; end: number }> = [];
  const separator = /\n[\t ]*\n+/g;
  let cursor = 0;
  for (const match of normalizedSource.matchAll(separator)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (normalizedSource.slice(cursor, start).trim().length > 0) spans.push({ start: cursor, end: start });
    cursor = end;
  }
  if (normalizedSource.slice(cursor).trim().length > 0) spans.push({ start: cursor, end: normalizedSource.length });

  const chunks: ParagraphChunk[] = [];
  let paragraphIndex = 0;
  for (const span of spans) {
    const paragraph = normalizedSource.slice(span.start, span.end);
    const parts: Array<{ text: string; start: number; end: number }> = [];
    let partStart = 0;
    let part = '';
    let byteLength = 0;
    for (const codePoint of paragraph) {
      const size = Buffer.byteLength(codePoint, 'utf8');
      if (size > maxChunkBytes) throw new KnowledgeError('INVALID_CONFIG', 'maxChunkBytes is too small for one UTF-8 code point');
      if (byteLength > 0 && byteLength + size > maxChunkBytes) {
        parts.push({ text: part, start: partStart, end: partStart + part.length });
        partStart += part.length;
        part = '';
        byteLength = 0;
      }
      part += codePoint;
      byteLength += size;
    }
    if (part.length > 0) parts.push({ text: part, start: partStart, end: partStart + part.length });
    for (const partSpan of parts) {
      const normalizedStart = span.start + partSpan.start;
      const normalizedEnd = span.start + partSpan.end;
      const rawStart = rawOffsetByNormalizedOffset[normalizedStart];
      const rawEnd = rawOffsetByNormalizedOffset[normalizedEnd];
      if (rawStart === undefined || rawEnd === undefined) throw new KnowledgeError('INVALID_LOCATOR', `${sourceName} normalized offset has no raw UTF-8 mapping`);
      const rawText = strictUtf8(bytes.slice(rawStart, rawEnd), `${sourceName} bytes ${rawStart}:${rawEnd}`);
      const text = normalizeNewlines(rawText);
      chunks.push({
        paragraphIndex,
        rawByteStart: rawStart,
        rawByteEndExclusive: rawEnd,
        normalizedStart,
        normalizedEnd,
        textHash: sha256Hex(Buffer.from(text, 'utf8')),
        text,
      });
    }
    paragraphIndex += 1;
  }

  return chunks;
}

export function extractByteRange(raw: Uint8Array, start: number, endExclusive: number): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive < start || endExclusive > raw.byteLength) {
    throw new KnowledgeError('INVALID_LOCATOR', `Invalid UTF-8 byte range ${start}:${endExclusive}`);
  }
  return strictUtf8(raw.slice(start, endExclusive), `byte range ${start}:${endExclusive}`);
}

export function tokenizeKeywordQuery(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens: string[] = [];
  const englishStopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'the', 'this', 'that', 'these', 'those', 'to', 'we', 'when', 'where', 'with']);
  const segments = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
  for (const segment of segments) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      const chars = [...segment];
      tokens.push(...chars);
      for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
    } else {
      if (!englishStopWords.has(segment)) tokens.push(segment);
    }
  }
  return [...new Set(tokens)];
}

export function estimateTokenCount(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
}

export function canonicalHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  return createHash('sha256').update(serialized).digest('hex');
}

export function makeArtifactRef(id: string, bytes: Uint8Array | string): ArtifactRef {
  return { id, sha256: sha256Hex(bytes) };
}

