import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { DATA_LIMITS, MATERIAL_NATURES, validateSource, validateDataset, type MaterialNature, type MaterialSource, type DatasetVersion, type DataField, type RawCell, type RawTable, type DataDiagnostics, type GeneralDataPreview } from '../contracts/general-data.ts';
import { validateGeneralResearch } from '../contracts/general-research.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { ResearchBootstrapStore, requireResearch, type MutationResult } from './research-bootstrap-store.ts';
import { GeneralMaterialStore, type MaterialStoreOptions, sha256 } from './general-material-store.ts';

interface Write { operationId: string; baseRevision: number; researchId: string }
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const missing = (value: RawCell, field: DataField): boolean => value === null || (typeof value === 'string' && field.missingValues.includes(value));
export function interpretedCell(value: RawCell, field: DataField): { value: RawCell; error: string | null } {
  if (missing(value, field)) return { value: null, error: null };
  if (field.type !== 'number') {
    if (field.type === 'time' && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) return { value: null, error: '时间格式未确认' };
    return { value, error: null };
  }
  if (typeof value !== 'number' && !(typeof value === 'string' && NUMBER.test(value.trim()))) return { value: null, error: '非数值记录；未当作 0' };
  const number = Number(value);
  const derived = field.conversion ? number * field.conversion.scale + field.conversion.offset : number;
  if (!Number.isFinite(number) || !Number.isFinite(derived)) return { value: null, error: '非有限数值或转换溢出' };
  return { value: derived, error: null };
}
function initialFields(table: RawTable): DataField[] {
  const used = new Set<string>();
  return table.headers.map((header, column) => {
    // Display label is bounded; the complete original header remains in the parsed raw table.
    let label = header.trim().slice(0, 250) || `列 ${column + 1}`;
    if (used.has(label)) label = `${label} [列 ${column + 1}]`;
    while (used.has(label)) label += '·';
    used.add(label);
    const values = table.rows.map(row => row[column]).filter(v => v !== null && v !== '');
    const numeric = !table.formulaColumns.includes(column) && values.length > 0 && values.every(v => typeof v === 'number' || (typeof v === 'string' && NUMBER.test(v.trim()) && !/^0\d/.test(v.trim())));
    return { column, label, type: numeric ? 'number' : 'text', role: 'other', unit: null, missingValues: [''], conversion: null };
  });
}
export function inspectDataset(table: RawTable, dataset: DatasetVersion): DataDiagnostics {
  const excluded = new Set(dataset.excludedRows);
  const missingCounts = new Map(dataset.fields.map(f => [f.column, 0]));
  const invalidCells: DataDiagnostics['invalidCells'] = [];
  const duplicates: number[] = [], repeated: number[] = [];
  const records = new Set<string>(), samples = new Set<string>();
  let invalidCellCount = 0;
  const sampleFields = dataset.fields.filter(f => f.role === 'sample');
  table.rows.forEach((row, index) => {
    if (excluded.has(index)) return;
    const key = JSON.stringify(row);
    if (records.has(key)) duplicates.push(index); else records.add(key);
    for (const field of dataset.fields) {
      const result = interpretedCell(row[field.column], field);
      if (missing(row[field.column], field)) missingCounts.set(field.column, missingCounts.get(field.column)! + 1);
      if (result.error) { invalidCellCount++; if (invalidCells.length < 100) invalidCells.push({ row: index, column: field.column, reason: result.error }); }
    }
    if (sampleFields.length && sampleFields.every(f => !missing(row[f.column], f))) {
      const sample = JSON.stringify(sampleFields.map(f => row[f.column]));
      if (samples.has(sample)) repeated.push(index); else samples.add(sample);
    }
  });
  const comparisonBlockers = dataset.fields.filter(f => f.type === 'number' && ['variable', 'outcome', 'uncertainty'].includes(f.role) && !f.unit?.trim()).map(f => `字段「${f.label}」单位未知；无量纲请明确填写 1。`);
  for (const condition of dataset.conditions) if (condition.value === null || !condition.value.trim()) comparisonBlockers.push(`条件「${condition.name}」待确认。`);
  if (invalidCellCount) comparisonBlockers.push(`${invalidCellCount} 个非法数值/时间单元格需明确处理，不参与隐式填补。`);
  for (const field of dataset.fields) if (field.type === 'number' && table.formulaColumns.includes(field.column)) comparisonBlockers.push(`字段「${field.label}」含 Excel 公式；未计算公式，需提供已确认数值版本。`);
  if (repeated.length && !dataset.fields.some(f => ['repeat', 'time'].includes(f.role))) comparisonBlockers.push('重复样本未指定重复/时间字段；不能把重复测量当独立样本比较。');
  return { totalRows: table.rows.length, includedRows: table.rows.length - excluded.size, missingByColumn: [...missingCounts].map(([column, count]) => ({ column, count })), invalidCells, invalidCellCount, duplicateRecordRows: duplicates, repeatedSampleRows: repeated, comparisonBlockers, notes: ['行 ID 为内部定位，不代表真实试件或受试者。', '重复记录按全部原始列值相等判断；重复样本按用户指定 sample 列判断，均未自动删除。', '缺失值不填为 0，原始值保留；非法值不被算作有效数值。'] };
}

export class GeneralDataService {
  readonly store: ResearchBootstrapStore;
  readonly materials: GeneralMaterialStore;
  constructor(store: ResearchBootstrapStore, options: MaterialStoreOptions = {}) { this.store = store; this.materials = new GeneralMaterialStore(store.workspaceRoot, options); }

  importMaterial(input: Write & { filename: string; mediaType: string; contentBase64: string; nature: MaterialNature; description: string; purpose: string; previousSourceId?: string | null }): MutationResult<{ sourceId: string; datasetIds: string[]; parseStatus: MaterialSource['parseStatus']; firstError: MaterialSource['firstError'] }> {
    if (typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 300 || /[\\/\x00-\x1f]/.test(input.filename) || ['.', '..'].includes(input.filename)) throw new BootstrapError('INVALID_INPUT', '文件名不能包含目录或控制字符。');
    if (!MATERIAL_NATURES.includes(input.nature)) throw new BootstrapError('INVALID_INPUT', '用户上传资料不能标为系统实际计算。');
    if (typeof input.contentBase64 !== 'string' || input.contentBase64.length > Math.ceil(DATA_LIMITS.maxFileBytes / 3) * 4 || input.contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.contentBase64)) throw new BootstrapError('INVALID_INPUT', '文件编码非法或超过 10 MiB。');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.toString('base64') !== input.contentBase64 || bytes.length > DATA_LIMITS.maxFileBytes) throw new BootstrapError('INVALID_INPUT', '文件编码非法或超过 10 MiB。');
    const contentHash = sha256(bytes);
    // Do not parse or create blobs outside the locked, authorized CAS operation.
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'import_general_material', researchId: input.researchId,
      requestPayload: { researchId: input.researchId, filename: input.filename, mediaType: input.mediaType, contentHash, nature: input.nature, description: input.description, purpose: input.purpose, previousSourceId: input.previousSourceId ?? null },
      apply: context => {
        const research = requireResearch(context.state, input.researchId);
        if (!research.general) throw new BootstrapError('INVALID_INPUT', '通用材料入口需要通用研究；旧论文来源路径保持原校验。');
        const previous = input.previousSourceId ? research.general.sources.find(s => s.sourceId === input.previousSourceId) : null;
        if (input.previousSourceId && !previous) throw new BootstrapError('SOURCE_MISSING', '上一来源不属于当前研究。');
        if (previous) assertGeneralSourceAccess(research.general, previous.sourceId);
        const parsed = this.materials.parse(input.filename, bytes);
        const sourceId = context.mint('source');
        const parseStatus: MaterialSource['parseStatus'] = parsed.error ? parsed.error.code === 'ATTACHMENT_ONLY' ? 'attachment' : 'failed' : 'parsed';
        // Validate metadata BEFORE writing blobs; failed transaction may leave only unreferenced immutable blobs.
        const parsedHash = sha256(JSON.stringify(parsed));
        const source = validateSource({ sourceId, revision: previous ? previous.revision + 1 : 1, previousSourceId: previous?.sourceId ?? null, filename: input.filename, mediaType: input.mediaType, sha256: contentHash, bytes: bytes.length, nature: input.nature, description: input.description, purpose: input.purpose, acquiredAt: context.now(), parser: parsed.parser, parsedSha256: parsedHash, parseStatus, firstError: parsed.error, tables: parsed.tables.map(t => ({ tableId: t.tableId, name: t.name, rowCount: t.rows.length, columnCount: t.headers.length })) });
        research.general.sources.push(source);
        const datasetIds: string[] = [];
        for (const table of parsed.tables) {
          const datasetId = context.mint('dataset'); datasetIds.push(datasetId);
          research.general.datasets.push(validateDataset({ datasetId, version: 1, sourceId, sourceSha256: contentHash, tableId: table.tableId, fields: initialFields(table), conditions: [], excludedRows: [], processingReason: '', createdAt: context.now() }));
        }
        research.general.revision++;
        research.general = validateGeneralResearch(research.general);
        const persisted = this.materials.persist(bytes, parsed);
        if (persisted.parsedSha256 !== source.parsedSha256) throw new BootstrapError('STATE_WRITE_FAILED', '解析内容 hash 不稳定。');
        research.updatedAt = context.now();
        return { changed: true, result: { sourceId, datasetIds, parseStatus, firstError: source.firstError } };
      },
    });
  }

  saveDictionary(input: Write & { datasetId: string; fields: DataField[]; conditions: DatasetVersion['conditions']; excludedRows: number[]; processingReason: string }): MutationResult<{ datasetId: string; version: number }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'save_general_dictionary', researchId: input.researchId,
      requestPayload: { researchId: input.researchId, datasetId: input.datasetId, fields: input.fields, conditions: input.conditions, excludedRows: input.excludedRows, processingReason: input.processingReason },
      apply: context => {
        const research = requireResearch(context.state, input.researchId);
        if (!research.general) throw new BootstrapError('INVALID_INPUT', '没有通用数据字典。');
        const previous = research.general.datasets.filter(d => d.datasetId === input.datasetId).sort((a, b) => b.version - a.version)[0];
        if (!previous) throw new BootstrapError('SOURCE_MISSING', '数据集不属于当前研究。');
        const source = research.general.sources.find(s => s.sourceId === previous.sourceId)!;
        assertGeneralSourceAccess(research.general, source.sourceId);
        this.materials.readParsed(source); // Recheck bytes + parsed hash before deriving a new version.
        const dataset = validateDataset({ ...previous, version: previous.version + 1, fields: input.fields, conditions: input.conditions, excludedRows: input.excludedRows, processingReason: input.processingReason, createdAt: context.now() });
        research.general.datasets.push(dataset);
        research.general.revision++;
        research.general = validateGeneralResearch(research.general);
        research.updatedAt = context.now();
        return { changed: true, result: { datasetId: dataset.datasetId, version: dataset.version } };
      },
    });
  }

  preview(input: { researchId: string; sourceId?: string; datasetId?: string; version?: number; tableId?: string; offset?: number; limit?: number }): GeneralDataPreview {
    const research = requireResearch(this.store.readStateOrEmpty(), input.researchId);
    if (!research.general) throw new BootstrapError('INVALID_INPUT', '没有通用资料。');
    const dataset = input.datasetId ? research.general.datasets.filter(d => d.datasetId === input.datasetId && (input.version === undefined || d.version === input.version)).sort((a, b) => b.version - a.version)[0] : undefined;
    if (input.datasetId && !dataset) throw new BootstrapError('SOURCE_MISSING', '数据集或指定版本不存在。');
    const source = research.general.sources.find(s => s.sourceId === (dataset?.sourceId ?? input.sourceId));
    if (!source) throw new BootstrapError('SOURCE_MISSING', '来源不属于当前研究。');
    assertGeneralSourceAccess(research.general, source.sourceId);
    const parsed = this.materials.readParsed(source);
    const table = parsed.tables.find(t => t.tableId === (dataset?.tableId ?? input.tableId)) ?? (input.tableId || dataset ? undefined : parsed.tables[0]);
    if (!table) { if (parsed.error) return { source, tables: source.tables, table: null, dataset: null, diagnostics: null, offset: 0, limit: DATA_LIMITS.previewRows, rows: [], error: parsed.error }; throw new BootstrapError('SOURCE_MISSING', '指定工作表不存在。'); }
    const offset = input.offset ?? 0, limit = input.limit ?? DATA_LIMITS.previewRows;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > DATA_LIMITS.previewRows) throw new BootstrapError('INVALID_INPUT', '预览需要合法分页，单页最多 100 行。');
    const selected = dataset ?? research.general.datasets.filter(d => d.sourceId === source.sourceId && d.tableId === table.tableId).sort((a, b) => b.version - a.version)[0];
    return { source, tables: source.tables, table: { tableId: table.tableId, name: table.name, headers: table.headers, formulaColumns: table.formulaColumns, totalRows: table.rows.length }, dataset: selected ?? null,
      diagnostics: selected ? inspectDataset(table, selected) : null, offset, limit,
      rows: table.rows.slice(offset, offset + limit).map((raw, i) => ({ rowIndex: offset + i, rowId: `internal-row-${offset + i + 1}`, excluded: selected?.excludedRows.includes(offset + i) ?? false, raw, values: selected ? selected.fields.map(f => interpretedCell(raw[f.column], f).value) : raw })), error: null };
  }
}
