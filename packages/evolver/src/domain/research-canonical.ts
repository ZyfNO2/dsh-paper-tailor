/**
 * canonical-json-v1, typed hashing, paper-text-v1 normalization, and code-point
 * evidence location. Spec: docs/mvp/PAPER-ONLY-CONTRACTS.md section 9.2.
 */

import * as crypto from 'node:crypto';
import { ResearchError, type EvidenceSpan } from '../contracts/research.ts';

export const CANONICAL_ENCODING_ID = 'canonical-json-v1';

/**
 * Arrays under these keys are semantically sets: deduplicated and content-sorted.
 * Every other array keeps its order (ablation rows, group id lists, quote spans, ...).
 */
export const CANONICAL_SET_KEYS = new Set<string>([
  'evidenceRefs',
  'evidenceSpans',
  'sourceEvidence',
  'basisRefs',
  'requiredInputs',
  'reasonCodes',
  'contributedMethods',
  'builtOnBaselines',
  'comparisonBaselines',
  'moduleMentions',
  'limitations',
  'requirements',
  'ablations',
  'allowedModuleRefs',
  'moduleCardRefs',
  'conceptualBindings',
  'expectedEffects',
  'risks',
  'requiredValidation',
  'unresolvedConditions',
  'exclusionReasons',
  'inputPaths',
  'constraints',
  'unresolvedFields',
  'availableSections',
  'eligibleIds',
  'conditionalIds',
  'notRankableIds',
  'excludedIds',
  'moduleRefs',
  'evaluationQuestions',
]);

function isSetKey(key: string): boolean {
  return CANONICAL_SET_KEYS.has(key);
}

function compareCanonicalStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Serializes to compact UTF-8 JSON with code-point-sorted object keys.
 * Rejects undefined, NaN/Infinity, -0 normalization, and dedupes/sorts set arrays.
 */
export function canonicalJsonV1(value: unknown, key?: string): string {
  if (value === undefined) {
    throw new ResearchError('SCHEMA_VIOLATION', `canonical-json-v1 rejects undefined${key ? ` at "${key}"` : ''}`);
  }

  if (value === null || typeof value === 'boolean') return JSON.stringify(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ResearchError('SCHEMA_VIOLATION', `canonical-json-v1 rejects non-finite number${key ? ` at "${key}"` : ''}`);
    }
    return JSON.stringify(value === 0 ? 0 : value);
  }

  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonV1(item, key));
    if (key !== undefined && isSetKey(key)) {
      const unique = Array.from(new Set(items)).sort(compareCanonicalStrings);
      return `[${unique.join(',')}]`;
    }
    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const keys: string[] = [];
    const byKey = new Map<string, string>();
    for (const [k, v] of entries) {
      if (k === '__proto__') {
        throw new ResearchError('SCHEMA_VIOLATION', `canonical-json-v1 rejects key "__proto__"`);
      }
      keys.push(k);
      byKey.set(k, canonicalJsonV1(v, k));
    }
    // Unicode code-point ordering (JS string comparison is by UTF-16 unit; ASCII-safe
    // field names in this protocol are identical under both).
    keys.sort(compareCanonicalStrings);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${byKey.get(k)}`).join(',')}}`;
  }

  throw new ResearchError('SCHEMA_VIOLATION', `canonical-json-v1 cannot encode ${typeof value}`);
}

/**
 * JSON parser that fails on duplicate object keys; numbers must be finite.
 */
export function parseJsonStrictV1(text: string): unknown {
  let cursor = 0;
  const src = text;

  function fail(message: string): never {
    throw new ResearchError('INVALID_INPUT', `${message} at offset ${cursor}`);
  }

  function skipWs(): void {
    while (cursor < src.length && /[\s]/.test(src[cursor])) cursor += 1;
  }

  function parseValue(depth: number): unknown {
    if (depth > 128) fail('maximum nesting depth exceeded');
    skipWs();
    const ch = src[cursor];
    if (ch === undefined) fail('unexpected end of input');
    if (ch === '{') return parseObject(depth);
    if (ch === '[') return parseArray(depth);
    if (ch === '"') return parseString();
    if (ch === 't') return parseLiteral('true', true);
    if (ch === 'f') return parseLiteral('false', false);
    if (ch === 'n') return parseLiteral('null', null);
    return parseNumber();
  }

  function parseLiteral(literal: string, result: unknown): unknown {
    if (src.startsWith(literal, cursor)) {
      cursor += literal.length;
      return result;
    }
    fail(`invalid token at "${src.slice(cursor, cursor + 8)}"`);
  }

  function parseString(): string {
    cursor += 1; // opening quote
    let out = '';
    while (cursor < src.length) {
      const ch = src[cursor];
      if (ch === '"') {
        cursor += 1;
        return out;
      }
      if (ch === '\\') {
        const esc = src[cursor + 1];
        switch (esc) {
          case '"':
          case '\\':
          case '/':
            out += esc;
            cursor += 2;
            break;
          case 'b':
            out += '\b';
            cursor += 2;
            break;
          case 'f':
            out += '\f';
            cursor += 2;
            break;
          case 'n':
            out += '\n';
            cursor += 2;
            break;
          case 'r':
            out += '\r';
            cursor += 2;
            break;
          case 't':
            out += '\t';
            cursor += 2;
            break;
          case 'u': {
            const hex = src.slice(cursor + 2, cursor + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            cursor += 6;
            break;
          }
          default:
            fail(`invalid escape "\\${esc}"`);
        }
        continue;
      }
      if (ch < ' ') fail('unescaped control character in string');
      out += ch;
      cursor += 1;
    }
    fail('unterminated string');
  }

  function parseNumber(): number {
    const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(cursor));
    if (!match) fail('invalid number');
    cursor += match[0].length;
    const num = Number(match[0]);
    if (!Number.isFinite(num)) fail(`non-finite number "${match[0]}"`);
    return num;
  }

  function parseObject(depth: number): Record<string, unknown> {
    cursor += 1; // opening brace
    const obj: Record<string, unknown> = {};
    skipWs();
    if (src[cursor] === '}') {
      cursor += 1;
      return obj;
    }
    for (;;) {
      skipWs();
      if (src[cursor] !== '"') fail('object key must be a string');
      const key = parseString();
      skipWs();
      if (src[cursor] !== ':') fail('expected ":"');
      cursor += 1;
      const value = parseValue(depth + 1);
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new ResearchError('INVALID_INPUT', `canonical-json-v1 rejects duplicate key "${key}"`);
      }
      obj[key] = value;
      skipWs();
      const ch = src[cursor];
      if (ch === ',') {
        cursor += 1;
        continue;
      }
      if (ch === '}') {
        cursor += 1;
        return obj;
      }
      fail(`unexpected character "${ch}" in object`);
    }
  }

  function parseArray(depth: number): unknown[] {
    cursor += 1;
    const arr: unknown[] = [];
    skipWs();
    if (src[cursor] === ']') {
      cursor += 1;
      return arr;
    }
    for (;;) {
      arr.push(parseValue(depth + 1));
      skipWs();
      const ch = src[cursor];
      if (ch === ',') {
        cursor += 1;
        continue;
      }
      if (ch === ']') {
        cursor += 1;
        return arr;
      }
      fail(`unexpected character "${ch}" in array`);
    }
  }

  const parsed = parseValue(0);
  skipWs();
  if (cursor !== src.length) fail('trailing characters after JSON value');
  return parsed;
}

/** hash = SHA256(UTF8(typeName + "\ncanonical-json-v1\n") + canonicalBytes) */
export function typedHash(typeName: string, value: unknown): string {
  const prefix = Buffer.from(`${typeName}\n${CANONICAL_ENCODING_ID}\n`, 'utf8');
  const body = Buffer.from(canonicalJsonV1(value), 'utf8');
  return crypto.createHash('sha256').update(prefix).update(body).digest('hex');
}

export function sha256Hex(bufferOrText: Buffer | string): string {
  const buf = typeof bufferOrText === 'string' ? Buffer.from(bufferOrText, 'utf8') : bufferOrText;
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export const HASH_DOMAINS = {
  request: 'request',
  candidate: 'candidate',
  corpus: 'corpus',
  policy: 'policy',
  report: 'report',
} as const;

export function computeRequestHash(payload: Record<string, unknown>): string {
  const { commandId: _commandId, ...semantics } = payload;
  return typedHash(HASH_DOMAINS.request, semantics);
}

export function computeCorpusHash(manifestEntries: unknown[]): string {
  return typedHash(HASH_DOMAINS.corpus, { entries: manifestEntries });
}

export function computeCandidateHash(payload: Record<string, unknown>): string {
  return typedHash(HASH_DOMAINS.candidate, payload);
}

export function computeScoringPolicyHash(policy: unknown): string {
  return typedHash(HASH_DOMAINS.policy, policy);
}

export function computeReportHash(report: Record<string, unknown>): string {
  const { reportHash: _reportHash, ...body } = report;
  return typedHash(HASH_DOMAINS.report, body);
}

// ----------------- paper-text-v1 -----------------

/**
 * UTF-8 strict decode, strip a leading BOM, CRLF/CR -> LF.
 * Deliberately no trim, no NFC, no whitespace collapsing.
 */
export function normalizePaperTextV1(raw: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new ResearchError('SOURCE_MISMATCH', 'paper-text-v1 requires strictly valid UTF-8');
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Half-open [start,end) over Unicode code points, not UTF-16 units. */
export function sliceByCodePoint(text: string, start: number, end: number): string {
  const chars = Array.from(text);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > chars.length || end <= start) {
    throw new ResearchError('EVIDENCE_INVALID', `Invalid code-point range [${start},${end}) for text of ${chars.length} code points`);
  }
  return chars.slice(start, end).join('');
}

/** Code-point offsets of a UTF-16 index, computed by counting up front. */
function utf16ToCodePointOffset(text: string, utf16Index: number): number {
  let cp = 0;
  for (let i = 0; i < utf16Index; i += 1) {
    const code = text.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const next = text.charCodeAt(i + 1);
    const isLowSurrogate = next >= 0xdc00 && next <= 0xdfff;
    if (isHighSurrogate && isLowSurrogate) {
      i += 1;
    }
    cp += 1;
  }
  return cp;
}

export interface QuoteLocation {
  start: number;
  end: number;
  hitCount: number;
}

/**
 * Locates a quote inside a normalized section. The Host only fills offsets when the
 * quote hits exactly once; zero or multiple hits must be reported as EVIDENCE_INVALID.
 */
export function locateQuote(sectionText: string, quote: string): QuoteLocation {
  if (quote.length === 0) {
    throw new ResearchError('EVIDENCE_INVALID', 'Empty quote cannot be located');
  }
  let hitCount = 0;
  let firstUtf16Index = -1;
  let from = 0;
  for (;;) {
    const idx = sectionText.indexOf(quote, from);
    if (idx === -1) break;
    if (hitCount === 0) firstUtf16Index = idx;
    hitCount += 1;
    from = idx + quote.length;
  }
  if (hitCount !== 1) {
    throw new ResearchError('EVIDENCE_INVALID', `Quote hit ${hitCount} times; expected exactly 1`, {
      fieldPaths: ['quote'],
    });
  }
  const start = utf16ToCodePointOffset(sectionText, firstUtf16Index);
  const end = start + codePointLength(quote);
  return { start, end, hitCount };
}

export interface SpanBuildInput {
  id: string;
  paperId: string;
  documentHash: string;
  section: string;
  sectionText: string;
  quote: string;
  /** Host-filled when omitted; a supplied range is re-checked against the text. */
  start?: number;
  end?: number;
}

export function buildEvidenceSpan(input: SpanBuildInput): EvidenceSpan {
  let start: number;
  let end: number;
  if (input.start === undefined || input.end === undefined) {
    const located = locateQuote(input.sectionText, input.quote);
    start = located.start;
    end = located.end;
  } else {
    const sliced = sliceByCodePoint(input.sectionText, input.start, input.end);
    if (sliced !== input.quote) {
      throw new ResearchError('EVIDENCE_INVALID', `Span [${input.start},${input.end}) does not match quote`, {
        fieldPaths: ['start', 'end'],
      });
    }
    start = input.start;
    end = input.end;
  }
  return {
    id: input.id,
    paperId: input.paperId,
    documentHash: input.documentHash,
    section: input.section,
    start,
    end,
    quote: input.quote,
    quoteHash: sha256Hex(Buffer.from(input.quote, 'utf8')),
  };
}

/** Re-reads the span from frozen section text and checks quote/hash/bounds. */
export function verifyEvidenceSpan(span: EvidenceSpan, sectionText: string): void {
  const sliced = sliceByCodePoint(sectionText, span.start, span.end);
  if (sliced !== span.quote) {
    throw new ResearchError('EVIDENCE_INVALID', `Span "${span.id}" quote does not match [${span.start},${span.end})`, {
      fieldPaths: [span.id],
    });
  }
  if (sha256Hex(Buffer.from(span.quote, 'utf8')) !== span.quoteHash) {
    throw new ResearchError('EVIDENCE_INVALID', `Span "${span.id}" quoteHash mismatch`, { fieldPaths: [`${span.id}.quoteHash`] });
  }
}
