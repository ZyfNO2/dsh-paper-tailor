/**
 * Loads the host-side Phase 2 configuration for the DSH plugin.
 *
 * Why a file and not inline YAML: `constraints` and `protocols` are typed values with real content
 * (a binding list, two frozen protocol bodies). Putting them in the bundle patch would mean the
 * committed `cordis.patch.yml` carries machine-local absolute paths AND a copy of protocol JSON
 * that already lives under `configs/phase2/`. Loading them from the repo keeps one source of truth
 * for the protocol bodies and lets the bundle name only paths.
 *
 * Nothing here decides anything. The module validates that the referenced files exist and load
 * through the FROZEN contract; every refusal still comes from ExperimentService with its own code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ExperimentError,
  validateLightweightProtocol,
  validatePlanBinding,
  type LightweightProtocol,
} from '../../contracts/experiments.ts';
import type { HostPlanningConstraints, HostProtocolEntry } from '../../application/experiment-service.ts';

export interface Phase2HostConfigPaths {
  /** Repository root; every other path resolves against it. */
  repoRoot: string;
  /** The host-owned planning constraints (bindings, path policy, required checks). */
  constraintsPath: string;
  /** The smoke protocol body. */
  smokeProtocolPath: string;
  /** The tiny protocol body. */
  tinyProtocolPath: string;
}

export interface Phase2HostConfig {
  constraints: HostPlanningConstraints;
  protocols: { smoke: HostProtocolEntry; tiny: HostProtocolEntry };
}

function loadJson(absPath: string, label: string): Record<string, unknown> {
  if (!fs.existsSync(absPath)) {
    throw new ExperimentError('CONFIG_INCOMPLETE', `${label} is missing: ${absPath}`, { fieldPaths: [label] });
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new ExperimentError('CONFIG_INCOMPLETE', `${label} is not parseable JSON: ${String(err)}`, {
      fieldPaths: [label],
    });
  }
}

/**
 * Reads the constraints file. Its `bindings` go through the FROZEN `PlanBinding` validator, so a
 * host typo (a duplicate module, a non-string id) is refused by the same code that refuses a
 * request, not by a second, looser parser here.
 */
export function loadPhase2Constraints(repoRoot: string, constraintsPath: string): HostPlanningConstraints {
  const abs = path.resolve(repoRoot, constraintsPath);
  const raw = loadJson(abs, 'constraintsPath');

  const rawBindings = Array.isArray(raw.bindings) ? raw.bindings : [];
  if (rawBindings.length === 0) {
    throw new ExperimentError('CONFIG_INCOMPLETE', 'host constraints declare no bindings', {
      fieldPaths: ['constraints.bindings'],
    });
  }
  const bindings = rawBindings.map((b, i) => validatePlanBinding(b, `constraints.bindings[${i}]`));

  const allowedPaths = Array.isArray(raw.allowedPaths) ? (raw.allowedPaths as string[]) : [];
  if (allowedPaths.length === 0) {
    throw new ExperimentError('CONFIG_INCOMPLETE', 'host constraints declare no allowedPaths', {
      fieldPaths: ['constraints.allowedPaths'],
    });
  }

  const constraints: HostPlanningConstraints = {
    id: String(raw.id ?? 'phase2-host-constraints'),
    bindings,
    allowedPaths,
    ...(Array.isArray(raw.forbiddenPaths) ? { forbiddenPaths: raw.forbiddenPaths as string[] } : {}),
    dependencyPolicyRef: String(raw.dependencyPolicyRef ?? 'policy:phase2-deps-frozen-v1'),
    mechanismChecks: Array.isArray(raw.mechanismChecks) ? (raw.mechanismChecks as string[]) : [],
    ...(typeof raw.maxRepairAttempts === 'number' ? { maxRepairAttempts: raw.maxRepairAttempts } : {}),
    ...(raw.moduleIdMap && typeof raw.moduleIdMap === 'object' ? { moduleIdMap: raw.moduleIdMap as Record<string, string> } : {}),
    ...(typeof raw.mechanismSteps === 'number' ? { mechanismSteps: raw.mechanismSteps } : {}),
    ...(raw.combination && typeof raw.combination === 'object'
      ? { combination: raw.combination as HostPlanningConstraints['combination'] }
      : {}),
    ...(raw.mechanismDeclarations && typeof raw.mechanismDeclarations === 'object'
      ? { mechanismDeclarations: raw.mechanismDeclarations as HostPlanningConstraints['mechanismDeclarations'] }
      : {}),
  };

  return constraints;
}

/** Loads one protocol body through the frozen validator, including its protocolHash. */
export function loadPhase2Protocol(repoRoot: string, protocolPath: string, id: string): HostProtocolEntry {
  const abs = path.resolve(repoRoot, protocolPath);
  const raw = loadJson(abs, protocolPath);
  // The file may hold the bare body or { id, body }.
  const candidate = (raw.body && typeof raw.body === 'object' ? raw.body : raw) as unknown;
  const body = validateLightweightProtocol(candidate, protocolPath) as LightweightProtocol;
  return { id: String(raw.id ?? id), body };
}

export function loadPhase2HostConfig(paths: Phase2HostConfigPaths): Phase2HostConfig {
  const repoRoot = path.resolve(paths.repoRoot);
  return {
    constraints: loadPhase2Constraints(repoRoot, paths.constraintsPath),
    protocols: {
      smoke: loadPhase2Protocol(repoRoot, paths.smokeProtocolPath, 'phase2-smoke-v1'),
      tiny: loadPhase2Protocol(repoRoot, paths.tinyProtocolPath, 'phase2-tiny-v1'),
    },
  };
}
