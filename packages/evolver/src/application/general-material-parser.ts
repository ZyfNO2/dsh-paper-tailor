import { DATA_LIMITS, validateParsedMaterial, type ParsedMaterial, type RawCell, type RawTable } from '../contracts/general-data.ts';

export const TABLE_PARSER_VERSION = 'dsh-table-parser/1';
export function parseCSV(text: string): RawTable {
  const records: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false, atStart = true, ended = false;
  const pushCell = () => { if (cell.length > DATA_LIMITS.maxCellCharacters) throw new Error('单元格超过 10000 字符。'); row.push(cell); cell = ''; atStart = true; closed = false; if (row.length > DATA_LIMITS.maxColumns) throw new Error('列数超过 200。'); };
  const pushRow = () => { pushCell(); records.push(row); row = []; if (records.length > DATA_LIMITS.maxRows + 1) throw new Error('数据行数超过 50000，未截断。'); };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; ended = false;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
      continue;
    }
    if (closed && c !== ',' && c !== '\r' && c !== '\n') throw new Error('CSV 引号后包含非法字符。');
    if (c === '"') { if (!atStart) throw new Error('CSV 未转义引号。'); quoted = true; atStart = false; }
    else if (c === ',') pushCell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; pushRow(); ended = true; }
    else { cell += c; atStart = false; }
  }
  if (quoted) throw new Error('CSV 引号未闭合。');
  if (!ended && text.length) pushRow();
  if (!records.length) throw new Error('CSV 没有表头。');
  const headers = records.shift()!;
  if (headers.every(v => !v.trim())) throw new Error('CSV 表头为空。');
  if (records.some(r => r.length !== headers.length)) throw new Error('CSV 行宽与表头不一致，原始文件保留为附件。');
  return { tableId: 'table-1', name: 'CSV', headers, rows: records, formulaColumns: [] };
}
function cell(value: unknown): RawCell {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value as RawCell;
  throw new Error('JSON 表格包含对象、数组或非有限数值单元格。');
}
export function parseTableJSON(text: string): RawTable {
  const data: unknown = JSON.parse(text);
  let headers: string[], rows: RawCell[][];
  if (Array.isArray(data) && data.length && data.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
    headers = [...new Set(data.flatMap(v => Object.keys(v)))];
    rows = data.map(v => headers.map(h => Object.hasOwn(v, h) ? cell(v[h]) : null));
  } else if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).every(k => k === 'columns' || k === 'rows')) {
    const t = data as { columns?: unknown; rows?: unknown };
    if (!Array.isArray(t.columns) || !t.columns.every(v => typeof v === 'string') || !Array.isArray(t.rows)) throw new Error('JSON 表格需要 columns 字符串数组和 rows 数组。');
    headers = t.columns;
    rows = t.rows.map(v => { if (!Array.isArray(v)) throw new Error('JSON rows 需要二维数组。'); return v.map(cell); });
  } else throw new Error('JSON 不符合支持的表结构（对象数组或 {columns, rows}）；保留为附件。');
  return { tableId: 'table-1', name: 'JSON', headers, rows, formulaColumns: [] };
}
export function parseTextMaterial(filename: string, bytes: Buffer): ParsedMaterial {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (!['csv', 'json'].includes(extension)) return { parser: TABLE_PARSER_VERSION, tables: [], error: { code: 'ATTACHMENT_ONLY', message: '该格式目前仅登记原始附件，不自动解析或执行。' } };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return validateParsedMaterial({ parser: TABLE_PARSER_VERSION, tables: [extension === 'csv' ? parseCSV(text) : parseTableJSON(text)], error: null });
  } catch (error) { return { parser: TABLE_PARSER_VERSION, tables: [], error: { code: 'PARSE_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) } }; }
}

/** Fixed parser program: reads workbook data only; never evaluates formulas, VBA or input text. */
export const XLSX_PARSER_SCRIPT = String.raw`
import sys, json, zipfile, datetime, math
import openpyxl
result = {'parser': 'dsh-xlsx-parser/1;openpyxl/' + openpyxl.__version__, 'tables': [], 'error': None}
try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(e.file_size for e in entries) > 40*1024*1024:
            raise ValueError('XLSX decompressed size or entry limit exceeded')
        if any(e.filename.lower().endswith('vbaproject.bin') for e in entries):
            raise ValueError('Macro-containing workbook is attachment-only; no macros executed')
    workbook = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=False, keep_links=False)
    try:
        if len(workbook.worksheets) > 20: raise ValueError('Worksheet limit exceeded (20)')
        cells = 0
        for index, sheet in enumerate(workbook.worksheets):
            if sheet.max_row and sheet.max_row > 50001: raise ValueError('Row limit exceeded (50000)')
            if sheet.max_column and sheet.max_column > 200: raise ValueError('Column limit exceeded (200)')
            matrix = []
            formula_columns = set()
            for row_index, row in enumerate(sheet.iter_rows()):
                if row_index > 50000: raise ValueError('Row limit exceeded (50000)')
                cells += len(row)
                if len(row) > 200 or cells > 500000: raise ValueError('Workbook cell limit exceeded')
                values = []
                for col_index, cell in enumerate(row):
                    value = cell.value
                    if cell.data_type == 'f': formula_columns.add(col_index)
                    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)): value = value.isoformat()
                    elif value is not None and not isinstance(value, (str, int, float, bool)): value = str(value)
                    if isinstance(value, float) and not math.isfinite(value): raise ValueError('Non-finite numeric cell')
                    if isinstance(value, str) and len(value) > 10000: raise ValueError('Cell character limit exceeded')
                    values.append(value)
                matrix.append(values)
            if not matrix or all(value is None for row in matrix for value in row): continue
            headers = ['' if value is None else str(value) for value in matrix[0]]
            if not any(header.strip() for header in headers): raise ValueError('Worksheet first row must contain headers')
            result['tables'].append({'tableId': 'sheet-' + str(index+1), 'name': sheet.title, 'headers': headers, 'rows': matrix[1:], 'formulaColumns': sorted(formula_columns)})
        if not result['tables']: raise ValueError('Workbook contains no tables')
    finally:
        workbook.close()
except Exception as error:
    result['tables'] = []
    result['error'] = {'code': 'PARSE_FAILED', 'message': str(error)[:4000]}
with open(sys.argv[2], 'w', encoding='utf-8') as output:
    json.dump(result, output, ensure_ascii=False, allow_nan=False)
`;
