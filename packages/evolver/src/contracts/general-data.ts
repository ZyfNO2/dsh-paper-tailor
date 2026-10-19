/** Provenance and table schemas: raw values and interpreted values are separate. */
export const DATA_LIMITS = Object.freeze({ maxFileBytes: 10 * 1024 * 1024, maxRows: 50000, maxColumns: 200, maxSheets: 20, maxCells: 500000, previewRows: 100, maxCellCharacters: 10000 });
export const MATERIAL_NATURES = ['literature', 'user_observation', 'user_result', 'simulation', 'hypothesis', 'inference', 'unknown'] as const;
export type MaterialNature = typeof MATERIAL_NATURES[number];
export type RawCell = string | number | boolean | null;
export interface RawTable { tableId: string; name: string; headers: string[]; rows: RawCell[][]; formulaColumns: number[] }
export interface ParsedMaterial { parser: string; tables: RawTable[]; error: { code: string; message: string } | null }
export interface MaterialSource {
  sourceId: string;
  revision: number;
  previousSourceId: string | null;
  filename: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  nature: MaterialNature;
  description: string;
  purpose: string;
  acquiredAt: string;
  parser: string;
  parsedSha256: string;
  parseStatus: 'parsed' | 'attachment' | 'failed';
  firstError: { code: string; message: string } | null;
  tables: { tableId: string; name: string; rowCount: number; columnCount: number }[];
}
export interface DataField {
  column: number;
  label: string;
  type: 'number' | 'category' | 'text' | 'time';
  role: 'variable' | 'outcome' | 'sample' | 'group' | 'time' | 'repeat' | 'condition' | 'uncertainty' | 'other';
  unit: string | null;
  missingValues: string[];
  /** Explicit derived unit conversion; never changes raw cells. */
  conversion: { scale: number; offset: number; targetUnit: string; reason: string } | null;
}
export interface DatasetVersion {
  datasetId: string;
  version: number;
  sourceId: string;
  sourceSha256: string;
  tableId: string;
  fields: DataField[];
  conditions: { name: string; value: string | null; unit: string | null }[];
  excludedRows: number[];
  processingReason: string;
  createdAt: string;
}
export interface DataDiagnostics {
  totalRows: number;
  includedRows: number;
  missingByColumn: { column: number; count: number }[];
  invalidCells: { row: number; column: number; reason: string }[];
  invalidCellCount: number;
  duplicateRecordRows: number[];
  repeatedSampleRows: number[];
  notes: string[];
  comparisonBlockers: string[];
}
export interface GeneralDataPreview {
  source: MaterialSource;
  tables: MaterialSource['tables'];
  table: { tableId: string; name: string; headers: string[]; formulaColumns: number[]; totalRows: number } | null;
  dataset: DatasetVersion | null;
  diagnostics: DataDiagnostics | null;
  offset: number;
  limit: number;
  rows: { rowIndex: number; rowId: string; excluded: boolean; raw: RawCell[]; values: RawCell[] }[];
  error: MaterialSource['firstError'];
}
function fail(s: string): never { throw new Error(`General data schema: ${s}`); }
export function object(v: unknown, fields: string[], label: string, optionalFields: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label} must be object`);
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some(k => !fields.includes(k)) || fields.some(k => !optionalFields.includes(k) && !(k in o))) fail(`${label} has unexpected or missing fields`);
  return o;
}
export function str(v: unknown, label: string, max = 4000, required = false): string {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail(`invalid ${label}`);
  return v as string;
}
export function num(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(`invalid ${label}`);
  return v as number;
}
export function list(v: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(`invalid ${label}`);
  return v as unknown[];
}
export function one<T extends string>(v: unknown, values: readonly T[], label: string): T {
  if (typeof v !== 'string' || !values.includes(v as T)) fail(`invalid ${label}`);
  return v as T;
}
export function hash(v: unknown): string {
  const h = str(v, 'hash', 64, true); if (!/^[a-f0-9]{64}$/.test(h)) fail('invalid hash'); return h;
}
function iso(v: unknown): string { const s = str(v, 'date', 100, true); if (!Number.isFinite(Date.parse(s))) fail('invalid date'); return s; }
const nullable = (v: unknown, label: string) => v === null ? null : str(v, label);
function error(v: unknown): MaterialSource['firstError'] {
  if (v === null) return null;
  const e = object(v, ['code', 'message'], 'error'); return { code: str(e.code, 'error code', 100, true), message: str(e.message, 'error message', 4000, true) };
}
export function validateSource(v: unknown): MaterialSource {
  const s = object(v, ['sourceId', 'revision', 'previousSourceId', 'filename', 'mediaType', 'sha256', 'bytes', 'nature', 'description', 'purpose', 'acquiredAt', 'parser', 'parsedSha256', 'parseStatus', 'firstError', 'tables'], 'source');
  const status = one(s.parseStatus, ['parsed', 'attachment', 'failed'] as const, 'parseStatus');
  const firstError = error(s.firstError);
  if ((status !== 'parsed') !== (firstError !== null)) fail('parse status/error disagree');
  const tables = list(s.tables, 'tables', DATA_LIMITS.maxSheets).map(v => {
    const t = object(v, ['tableId', 'name', 'rowCount', 'columnCount'], 'table summary');
    return { tableId: str(t.tableId, 'tableId', 200, true), name: str(t.name, 'name', 300, true), rowCount: num(t.rowCount, 'rowCount', 0, DATA_LIMITS.maxRows), columnCount: num(t.columnCount, 'columnCount', 1, DATA_LIMITS.maxColumns) };
  });
  if ((status === 'parsed') !== (tables.length > 0)) fail('parse status/tables disagree');
  if (new Set(tables.map(t => t.tableId)).size !== tables.length) fail('duplicate table id');
  const filename = str(s.filename, 'filename', 300, true);
  if (/[\\/\x00-\x1f]/.test(filename) || filename === '.' || filename === '..') fail('filename must be a label, not a path');
  const revision = num(s.revision, 'source revision', 1, 1000);
  const previousSourceId = s.previousSourceId === null ? null : str(s.previousSourceId, 'previousSourceId', 200, true);
  if ((revision === 1) !== (previousSourceId === null)) fail('source revision requires correct predecessor');
  return { sourceId: str(s.sourceId, 'sourceId', 200, true), revision, previousSourceId, filename, mediaType: str(s.mediaType, 'mediaType', 200, true), sha256: hash(s.sha256), bytes: num(s.bytes, 'bytes', 0, DATA_LIMITS.maxFileBytes), nature: one(s.nature, MATERIAL_NATURES, 'nature'), description: str(s.description, 'description'), purpose: str(s.purpose, 'purpose'), acquiredAt: iso(s.acquiredAt), parser: str(s.parser, 'parser', 200, true), parsedSha256: hash(s.parsedSha256), parseStatus: status, firstError, tables };
}
export function validateDataset(v: unknown): DatasetVersion {
  const d = object(v, ['datasetId', 'version', 'sourceId', 'sourceSha256', 'tableId', 'fields', 'conditions', 'excludedRows', 'processingReason', 'createdAt'], 'dataset');
  const fields = list(d.fields, 'fields', DATA_LIMITS.maxColumns).map(v => {
    const f = object(v, ['column', 'label', 'type', 'role', 'unit', 'missingValues', 'conversion'], 'field');
    let conversion: DataField['conversion'] = null;
    if (f.conversion !== null) {
      const c = object(f.conversion, ['scale', 'offset', 'targetUnit', 'reason'], 'conversion');
      if (typeof c.scale !== 'number' || !Number.isFinite(c.scale) || c.scale === 0 || typeof c.offset !== 'number' || !Number.isFinite(c.offset)) fail('invalid affine conversion');
      conversion = { scale: c.scale, offset: c.offset, targetUnit: str(c.targetUnit, 'targetUnit', 100, true), reason: str(c.reason, 'conversion reason', 2000, true) };
    }
    const result: DataField = { column: num(f.column, 'column', 0, DATA_LIMITS.maxColumns - 1), label: str(f.label, 'label', 300, true), type: one(f.type, ['number', 'category', 'text', 'time'] as const, 'type'), role: one(f.role, ['variable', 'outcome', 'sample', 'group', 'time', 'repeat', 'condition', 'uncertainty', 'other'] as const, 'role'), unit: nullable(f.unit, 'unit'), missingValues: list(f.missingValues, 'missingValues', 50).map(v => str(v, 'missing marker', 100)), conversion };
    if (conversion && (result.type !== 'number' || !result.unit?.trim())) fail('conversion requires numeric field and original unit');
    return result;
  });
  if (new Set(fields.map(f => f.column)).size !== fields.length || new Set(fields.map(f => f.label)).size !== fields.length) fail('duplicate mapping column or label');
  fields.sort((a, b) => a.column - b.column);
  const conditions = list(d.conditions, 'conditions', 100).map(v => { const c = object(v, ['name', 'value', 'unit'], 'condition'); return { name: str(c.name, 'condition name', 300, true), value: nullable(c.value, 'condition value'), unit: nullable(c.unit, 'condition unit') }; });
  if (new Set(conditions.map(c => c.name)).size !== conditions.length) fail('duplicate condition name');
  const excludedRows = list(d.excludedRows, 'excludedRows', DATA_LIMITS.maxRows).map(v => num(v, 'excluded row', 0, DATA_LIMITS.maxRows - 1));
  if (new Set(excludedRows).size !== excludedRows.length) fail('duplicate excluded row');
  const processingReason = str(d.processingReason, 'processingReason', 4000);
  if ((excludedRows.length || fields.some(f => f.conversion)) && !processingReason.trim()) fail('data processing requires a reason');
  return { datasetId: str(d.datasetId, 'datasetId', 200, true), version: num(d.version, 'version', 1, 1000), sourceId: str(d.sourceId, 'sourceId', 200, true), sourceSha256: hash(d.sourceSha256), tableId: str(d.tableId, 'tableId', 200, true), fields, conditions, excludedRows, processingReason, createdAt: iso(d.createdAt) };
}
export function validateParsedMaterial(v: unknown): ParsedMaterial {
  const p = object(v, ['parser', 'tables', 'error'], 'parsed material');
  let cells = 0;
  const tables = list(p.tables, 'tables', DATA_LIMITS.maxSheets).map(v => {
    const t = object(v, ['tableId', 'name', 'headers', 'rows', 'formulaColumns'], 'raw table');
    const headers = list(t.headers, 'headers', DATA_LIMITS.maxColumns).map(v => str(v, 'header', DATA_LIMITS.maxCellCharacters));
    if (!headers.length) fail('empty table columns');
    const rows = list(t.rows, 'rows', DATA_LIMITS.maxRows).map(v => {
      const row = list(v, 'row', DATA_LIMITS.maxColumns);
      if (row.length !== headers.length) fail('ragged row');
      cells += row.length; if (cells > DATA_LIMITS.maxCells) fail('cell limit exceeded');
      return row.map(v => {
        if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v as RawCell;
        return str(v, 'cell', DATA_LIMITS.maxCellCharacters);
      });
    });
    const formulaColumns = list(t.formulaColumns, 'formulaColumns', DATA_LIMITS.maxColumns).map(v => num(v, 'formula column', 0, headers.length - 1));
    return { tableId: str(t.tableId, 'tableId', 200, true), name: str(t.name, 'table name', 300, true), headers, rows, formulaColumns };
  });
  if (new Set(tables.map(t => t.tableId)).size !== tables.length) fail('duplicate table');
  const err = error(p.error);
  if ((err !== null) === (tables.length > 0)) fail('parsed material error/tables disagree');
  return { parser: str(p.parser, 'parser', 200, true), tables, error: err };
}
