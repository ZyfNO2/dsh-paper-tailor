import { parseCSV } from '../../evolver/src/application/general-material-parser.ts';
import { ResearchCoreError, type MetricPin } from '../../research-contracts/src/index.ts';

export interface MetricClaim {
  name: string;
  value: number | null;
  unit: string;
  row: number;
  column: number;
}

const RATIO_NAMES = new Set(['miou', 'iou', 'dice', 'f1', 'acc', 'accuracy', 'map']);

function foldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function headerMatches(header: string, name: string): boolean {
  const left = foldName(header);
  const right = foldName(name);
  return Boolean(left) && Boolean(right) && (left === right || left.startsWith(right) || right.startsWith(left));
}

function unitInHeader(header: string): string | null {
  const match = header.match(/\(([^)]+)\)|\[([^\]]+)\]/);
  const unit = (match?.[1] ?? match?.[2] ?? '').trim();
  return unit || null;
}

function numericToken(cell: string): { token: string; value: number } | null {
  const token = cell.trim();
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? { token, value } : null;
}

/** Cell, header, unit and run id must agree. A missing cell stays null and is never stored as 0. */
export function checkMetricTable(text: string, claims: MetricClaim[], runId: string, failureQuote: string | null): MetricPin[] {
  if (!claims.length && !failureQuote) {
    throw new ResearchCoreError('INVALID_INPUT', 'a run with no metric needs a failure quote from the file');
  }
  if (failureQuote && !text.includes(failureQuote)) {
    throw new ResearchCoreError('INVALID_INPUT', 'failure quote is not in the metrics file');
  }
  let table;
  try {
    table = parseCSV(text);
  } catch (error) {
    throw new ResearchCoreError('INVALID_INPUT', `metrics file is not a readable table: ${error instanceof Error ? error.message : String(error)}`);
  }
  const runColumn = table.headers.findIndex((header) => foldName(header) === 'runid' || foldName(header) === 'run');
  return claims.map((claim) => {
    const name = claim.name.trim();
    const unit = claim.unit.trim();
    if (!name || !Number.isSafeInteger(claim.row) || !Number.isSafeInteger(claim.column) || claim.row < 0 || claim.column < 0) {
      throw new ResearchCoreError('INVALID_INPUT', 'metric location is not valid');
    }
    if (claim.value !== null && !Number.isFinite(claim.value)) throw new ResearchCoreError('INVALID_INPUT', `metric ${name} is not a finite number`);
    if (claim.value === null) {
      if (!failureQuote) throw new ResearchCoreError('INVALID_INPUT', `metric ${name} is null and cannot be stored as 0`);
      return { name, value: null, unit, row: claim.row, column: claim.column, token: 'null' };
    }
    const header = table.headers[claim.column];
    if (!header || !headerMatches(header, name)) {
      throw new ResearchCoreError('INVALID_INPUT', `metric ${name} does not match column ${claim.column} header ${header ?? 'missing'}`);
    }
    const declaredUnit = unitInHeader(header);
    if (declaredUnit) {
      if (foldName(declaredUnit) !== foldName(unit)) throw new ResearchCoreError('INVALID_INPUT', `unit ${unit} is not the unit declared by ${header}`);
    } else if (!(RATIO_NAMES.has(foldName(name)) && unit === '1') && unit !== '未知') {
      throw new ResearchCoreError('INVALID_INPUT', `header ${header} does not declare unit ${unit}`);
    }
    const cell = table.rows[claim.row]?.[claim.column];
    const parsed = cell === undefined ? null : numericToken(String(cell));
    if (!parsed || parsed.value !== claim.value) {
      throw new ResearchCoreError('INVALID_INPUT', `metric ${name} does not match row ${claim.row} column ${claim.column}`);
    }
    if (runColumn >= 0) {
      const rowRun = String(table.rows[claim.row]?.[runColumn] ?? '').trim();
      if (rowRun !== runId) throw new ResearchCoreError('INVALID_INPUT', `run id must be the run_id on the ${name} row`);
    }
    return { name, value: claim.value, unit, row: claim.row, column: claim.column, token: parsed.token };
  });
}
