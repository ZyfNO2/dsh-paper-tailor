import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateBootstrapState } from '../../evolver/src/contracts/research-bootstrap.ts';
import {
  ResearchCoreError,
  emptyResultCounts,
  type LegacyInventory,
  type ResultCatalogCounts,
} from '../../research-contracts/src/index.ts';
import { resolveResearchRoot } from './root.ts';

const RESULT_KINDS = ['external_reported', 'mock'] as const;
const EXECUTIONS = ['succeeded', 'failed'] as const;

/** Read-only counts. Legacy session metadata is reported and is not a research fact. */
export function readLegacyInventory(workspaceDir: string): LegacyInventory {
  const root = resolveResearchRoot(workspaceDir);
  const stateFile = path.join(root.legacyDir, 'bootstrap', 'state.json');
  const empty = emptyInventory();
  if (!fs.existsSync(stateFile)) return { ...empty, ...readSidecars(root.workspaceDir) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (error) {
    throw new ResearchCoreError('STATE_CORRUPT', `legacy bootstrap state.json is not valid JSON: ${String(error)}`);
  }
  let state;
  try {
    state = validateBootstrapState(parsed);
  } catch (error) {
    throw new ResearchCoreError('STATE_CORRUPT', `legacy bootstrap state failed validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  let wikiEvidenceCount = 0;
  let sourceEvidenceCount = 0;
  let graphNodeCount = 0;
  let graphEdgeCount = 0;
  let ideaCount = 0;
  for (const research of state.researches) {
    ideaCount += research.ideas.length;
    for (const idea of research.ideas) {
      for (const ref of idea.evidenceRefs) {
        if (ref.assetKind === 'wiki') wikiEvidenceCount += 1;
        if (ref.assetKind === 'source') sourceEvidenceCount += 1;
      }
    }
    if (research.graph) {
      graphNodeCount += research.graph.nodes.length;
      graphEdgeCount += research.graph.edges.length;
    }
  }
  return {
    bootstrapPresent: true,
    bootstrapRevision: state.revision,
    researchCount: state.researches.length,
    ideaCount,
    graphNodeCount,
    graphEdgeCount,
    receiptCount: state.receipts.length,
    wikiEvidenceCount,
    sourceEvidenceCount,
    ...readSidecars(root.workspaceDir),
  };
}

function emptyInventory(): Pick<LegacyInventory, 'bootstrapPresent' | 'bootstrapRevision' | 'researchCount' | 'ideaCount' | 'graphNodeCount' | 'graphEdgeCount' | 'receiptCount' | 'wikiEvidenceCount' | 'sourceEvidenceCount'> {
  return {
    bootstrapPresent: false,
    bootstrapRevision: null,
    researchCount: 0,
    ideaCount: 0,
    graphNodeCount: 0,
    graphEdgeCount: 0,
    receiptCount: 0,
    wikiEvidenceCount: 0,
    sourceEvidenceCount: 0,
  };
}

function readSidecars(workspaceDir: string): Pick<LegacyInventory, 'results' | 'legacyAdapter'> {
  return { results: readResultCatalog(workspaceDir), legacyAdapter: readAdapterMetadata(workspaceDir) };
}

function readResultCatalog(workspaceDir: string): ResultCatalogCounts {
  const indexPath = path.join(workspaceDir, 'results', 'index.json');
  const counts = emptyResultCounts();
  if (!fs.existsSync(indexPath)) return counts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (error) {
    throw new ResearchCoreError('STATE_CORRUPT', `results/index.json is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ResearchCoreError('SCHEMA_VIOLATION', 'results/index.json must be an object');
  }
  const runs = (parsed as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) throw new ResearchCoreError('SCHEMA_VIOLATION', 'results/index.json runs must be a list');
  for (const run of runs) {
    if (typeof run !== 'object' || run === null) throw new ResearchCoreError('SCHEMA_VIOLATION', 'result catalog entry must be an object');
    const entry = run as { file?: unknown; recordKind?: unknown; execution?: unknown };
    if (typeof entry.file !== 'string' || entry.file.split(/[\\/]/).includes('..') || path.isAbsolute(entry.file)) {
      throw new ResearchCoreError('PATH_ESCAPE', 'result catalog file must be a relative name');
    }
    const filePath = path.resolve(workspaceDir, 'results', entry.file);
    const relative = path.relative(path.resolve(workspaceDir, 'results'), filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ResearchCoreError('PATH_ESCAPE', `result catalog file leaves results/: ${entry.file}`);
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new ResearchCoreError('NOT_FOUND', `result catalog file is missing: ${entry.file}`);
    }
    if (typeof entry.recordKind !== 'string' || !(RESULT_KINDS as readonly string[]).includes(entry.recordKind)) {
      throw new ResearchCoreError('SCHEMA_VIOLATION', 'result recordKind must be external_reported or mock');
    }
    if (typeof entry.execution !== 'string' || !(EXECUTIONS as readonly string[]).includes(entry.execution)) {
      throw new ResearchCoreError('SCHEMA_VIOLATION', 'result execution must be succeeded or failed');
    }
    if (entry.recordKind === 'mock') counts.mock += 1;
    else if (entry.execution === 'succeeded') counts.externalReportedSucceeded += 1;
    else counts.externalReportedFailed += 1;
  }
  return counts;
}

function readAdapterMetadata(workspaceDir: string): LegacyInventory['legacyAdapter'] {
  const filePath = path.join(workspaceDir, 'legacy', 'adapter-metadata.json');
  if (!fs.existsSync(filePath)) return { present: false, authoritative: false, sessionId: null, grantId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ResearchCoreError('STATE_CORRUPT', `legacy adapter metadata is not valid JSON: ${String(error)}`);
  }
  const dsh = typeof parsed === 'object' && parsed !== null ? (parsed as { dsh?: unknown }).dsh : undefined;
  const sessionId = typeof dsh === 'object' && dsh !== null && typeof (dsh as { sessionId?: unknown }).sessionId === 'string'
    ? (dsh as { sessionId: string }).sessionId : null;
  const grantId = typeof dsh === 'object' && dsh !== null && typeof (dsh as { grantId?: unknown }).grantId === 'string'
    ? (dsh as { grantId: string }).grantId : null;
  return { present: true, authoritative: false, sessionId, grantId };
}
