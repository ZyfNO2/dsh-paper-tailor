/**
 * TaskProfile host binding for the first Phase 2 execution profile (`phase2-cpu-seg-v1`).
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md section 5 — "为首个任务新增 profile 的
 * compileRecipe(implementation, bindings)、prepareRun(protocol, variant, seed) 与
 * verifyRun(manifest, facts, artifacts) 三个实际函数即可. profile 注册到受信配置."
 *
 * Design rules this file exists to enforce:
 *
 * 1. A profile is a TRUSTED HOST CONFIG. `runnerRef` / `compilerRef` / `verifierRef` are opaque
 *    strings resolved through `configs/phase2/profile-registry.json` into the three real functions
 *    below. A request may never carry a runner path, an interpreter path, an argv or an executable;
 *    `assertNoRequestSuppliedExecutable()` refuses such a payload with POLICY_DENIED before any
 *    other validation runs.
 * 2. `compileRecipe(implementation, bindings)` builds the recipe from module ids + bindings. It
 *    contains no A/B name comparison and no hardcoded insertion position — unlike
 *    experiments/stitch-cpu-v1/recipe-builder.ts, which is left untouched on purpose.
 * 3. This module does not modify and does not depend on the stitch-cpu-v1 implementation
 *    (recipe-builder.ts / task-adapter.ts / host-verifier.ts). Those keep their own 16-sample,
 *    4x2-logit, 5-step assertions; this profile declares its own.
 *
 * The profile's `environmentRef` is a real environment pin
 * (configs/phase2/environment-cpu-seg-v1.json) that records interpreter version, package lock,
 * framework/CUDA/driver and device. A hash of `pythonPath` alone is explicitly NOT sufficient and
 * is not what is recorded here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  ExperimentError,
  validateTaskProfile,
  computeLightweightProtocolHash,
  lightweightProtocolBody,
  type ArtifactRef,
  type LightweightProtocol,
  type TaskProfile,
  type SlotContract,
} from '../contracts/experiments.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PHASE2_CONFIG_DIR = 'configs/phase2';
export const PROFILE_ID = 'phase2-cpu-seg-v1';
export const PROFILE_VERSION = 1;

/** The frozen P6 v1 module cap. v2 raises it to 8 but is opt-in and not this profile's contract. */
export const PROFILE_MAX_MODULES = 3;
/** The source contract this profile may consume. Guards a v1/v2 mix-up. */
export const PROFILE_SOURCE_CONTRACT_MAX = 1;

/** Fields a request may never supply: they would let a caller choose the executable or the code. */
export const REQUEST_FORBIDDEN_EXECUTABLE_FIELDS: readonly string[] = Object.freeze([
  'runnerPath',
  'runnerRef',
  'interpreterPath',
  'pythonPath',
  'executable',
  'executablePath',
  'argv',
  'command',
  'script',
  'scriptPath',
  'shell',
  'cwd',
  'env',
  'envVars',
  'subprocess',
  'entrypointPath',
  // A module path is code the runner will import. If a request could name it, the request could
  // run arbitrary Python regardless of the runner being pinned. Modules are named by id only.
  'implementationPath',
  'modulePath',
  'moduleSourcePath',
  'codeTreeRefPath',
  'baseWeightPath',
  'weightsPath',
  'patchPath',
  'patchRefPath',
]);

/** Path-typed request fields whose value must resolve inside a policy root. */
const REQUEST_PATH_FIELDS: readonly string[] = Object.freeze(['manifestPath', 'outputDir', 'workspaceRoot']);

// ---------------------------------------------------------------------------
// Config file shapes (host-owned, validated on load)
// ---------------------------------------------------------------------------

export interface IsolationPolicy {
  policyId: string;
  enforcement: string;
  backend: Record<string, unknown>;
  readableRoots: string[];
  writableRoots: string[];
  deniedPaths: string[];
  deniedPathReasons: Record<string, string>;
  requestCannotSupply: string[];
}

export interface EnvironmentPin {
  environmentId: string;
  device: string;
  interpreter: { id: string; path: string; sha256: string; version: string; implementation: string };
  nodeInterpreter: { id: string; path: string; sha256: string; version: string };
  packageLock: {
    present: boolean;
    kind: string;
    command: string;
    normalization: string;
    packageCount: number;
    sha256: string;
    honestLimitation: string;
  };
  packages: Record<string, string>;
  framework: { name: string; version: string; cudaBuild: string; cudnn: string; deterministicAlgorithmsSupported: boolean };
  cuda: Record<string, unknown>;
  host: Record<string, unknown>;
  allowedDifferences: string[];
  mustMatchExactly: string[];
}

export interface SlotSchema {
  slotId: string;
  direction: 'input' | 'output';
  layout: string;
  shape: number[];
  dtype: string;
  device: string;
  mask: { present: boolean; semantics: string };
  batch: Record<string, unknown>;
  label: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SlotSchemaSet {
  schemaSetId: string;
  schemas: Record<string, SlotSchema>;
}

export interface OrderRule {
  slotId: string;
  kind: string;
  rule: string;
  maxModules: number;
  constraints: Array<{ id: string; rule: string; enforcedBy: string; errorCode: string | null }>;
}

export interface OrderRuleSet {
  ruleSetId: string;
  rules: Record<string, OrderRule>;
}

export interface RegistryRef {
  kind: 'runner' | 'compiler' | 'verifier';
  module: string;
  symbol: string;
  description: string;
  script?: string;
  scriptSha256?: string;
  interpreter?: { path: string; sha256: string; version: string };
  argvTemplate?: string[];
  argvRule?: string;
}

export interface ProfileRegistryEntry {
  profileFile: string;
  environmentRef: string;
  isolationPolicyRef: string;
  slotSchemaRef: string;
  orderRuleRef: string;
  toleranceRef: string;
  budgetRef: string;
  executionConfigRef: string;
  pins: Record<string, unknown>;
  runtime: RegistryRuntime;
  pinnedModules: PinnedModule[];
  pinnedModuleRule: string;
  refs: Record<string, RegistryRef>;
}

/** Host-owned run parameters. A request may not raise the timeout or change the data spec. */
export interface RegistryRuntime {
  baselineImplementationPath: string;
  baselineImplementationSha256: string;
  baseWeightPath: string;
  baseWeightSha256: string;
  timeoutMs: number;
  learningRate: number;
  batchSize: number;
  /** Channel width at the slot, i.e. the baseline's post-conv width. */
  slotChannels: number;
  dataSpec: {
    kind: string;
    seed: number;
    sampleCount: number;
    shape: number[];
    numClasses: number;
    /**
     * `real_slice` only: the prepared dataset file and the hash it must still
     * have. The runner verifies the bytes before reading them, so a dataset that
     * changed on disk is a refusal rather than a different experiment wearing
     * the same run identity. Absent for `synthetic`, which is generated from
     * (seed, sampleCount, shape, numClasses) and has no external bytes at all.
     */
    slicePath?: string;
    sliceSha256?: string;
  };
  note: string;
}

export interface ProfileRegistry {
  registryId: string;
  profiles: Record<string, ProfileRegistryEntry>;
}

/**
 * The resolved, fully checked profile. Everything a run needs, already validated. A caller holds
 * this object instead of a pile of paths, which is what makes the "trusted host config" rule
 * checkable rather than aspirational.
 */
export interface ResolvedTaskProfile {
  profile: TaskProfile;
  profileRef: string;
  registry: ProfileRegistry;
  entry: ProfileRegistryEntry;
  environment: EnvironmentPin;
  isolation: IsolationPolicy;
  slotSchemas: SlotSchemaSet;
  orderRules: OrderRuleSet;
  runner: { ref: RegistryRef; scriptAbsPath: string; scriptSha256: string; interpreterAbsPath: string; interpreterSha256: string; interpreterVersion: string };
  compiler: RegistryRef;
  verifier: RegistryRef;
  /** Host-pinned module sources. The only modules a binding may name. */
  pinnedModules: PinnedModule[];
  /** Absolute path of the pinned baseline implementation. */
  baselineImplementationPath: string;
  /** Absolute path of the pinned baseline weights, or null when the runner should create them. */
  baseWeightPath: string | null;
  /** Host-owned per-attempt timeout; a request may not raise it. */
  timeoutMs: number;
  learningRate: number;
  batchSize: number;
  dataSpec: RegistryRuntime['dataSpec'];
  /** When true, module file hashes are re-read from disk during compileRecipe. */
  verifyModuleHashesOnDisk: boolean;
  repoRoot: string;
  configDir: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readJson(absPath: string, what: string): Record<string, unknown> {
  if (!fs.existsSync(absPath)) {
    throw new ExperimentError('NOT_FOUND', `${what} not found at ${absPath}`, { fieldPaths: [absPath] });
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${what} at ${absPath} is not valid JSON: ${String(err)}`, {
      fieldPaths: [absPath],
    });
  }
}

function requireString(obj: Record<string, unknown>, key: string, context: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${context}.${key} must be a non-empty string`, {
      fieldPaths: [`${context}.${key}`],
    });
  }
  return v;
}

function requireStringArray(obj: Record<string, unknown>, key: string, context: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length > 0)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${context}.${key} must be a non-empty-string array`, {
      fieldPaths: [`${context}.${key}`],
    });
  }
  return v as string[];
}

function requireNumber(obj: Record<string, unknown>, key: string, context: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${context}.${key} must be a finite number`, {
      fieldPaths: [`${context}.${key}`],
    });
  }
  return v;
}

function sha256File(absPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// The request-side guard: no request may choose the executable
// ---------------------------------------------------------------------------

/**
 * Refuses a request payload that tries to supply an executable, an argv, a shell or an
 * environment. Walks nested objects and arrays so a nested `{ recipe: { runnerPath: ... } }` is
 * caught as well.
 *
 * This is the single most important guard in the file: without it, `runnerRef` being a "trusted
 * string" would only be a convention.
 */
export function assertNoRequestSuppliedExecutable(payload: unknown, context = 'request'): void {
  const hits: string[] = [];

  const walk = (node: unknown, trail: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${trail}[${i}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = `${trail}.${key}`;
      if (REQUEST_FORBIDDEN_EXECUTABLE_FIELDS.includes(key)) {
        hits.push(here);
        continue;
      }
      if (REQUEST_PATH_FIELDS.includes(key) && typeof value === 'string' && value.length > 0) {
        // A path-typed field is allowed only when it resolves inside the repository. It can never
        // be used to point at an arbitrary program because the runner script and interpreter are
        // taken from the registry, never from the request.
        const resolved = path.resolve(value);
        if (!resolved.startsWith(path.resolve('.') + path.sep)) {
          hits.push(`${here} (escapes the repository root)`);
          continue;
        }
      }
      walk(value, here);
    }
  };

  walk(payload, context);

  if (hits.length > 0) {
    throw new ExperimentError(
      'POLICY_DENIED',
      `a request may not supply an executable, an argv, a shell or an out-of-repo path; offending field(s): ${hits.join(', ')}. ` +
        'The runner script, the interpreter and the argv come from the host profile registry (configs/phase2/profile-registry.json) only.',
      { fieldPaths: hits }
    );
  }
}

/**
 * The isolation policy is enforced, not declared. Resolves the target and compares it against the
 * deny list first, then the allow list — the same order packages/evolver/src/domain/paper-discovery.ts
 * uses, so "directory separation alone is not isolation" holds here too.
 */
export function assertIsolationPolicy(
  policy: IsolationPolicy,
  target: string,
  mode: 'read' | 'write'
): { allowed: boolean; reason: string } {
  const roots = mode === 'write' ? policy.writableRoots : policy.readableRoots;
  const resolvedRoots = roots.map((r) => path.resolve(r));
  const resolvedDenied = policy.deniedPaths.map((d) => path.resolve(d));
  const abs = path.resolve(target);

  for (const denied of resolvedDenied) {
    if (abs === denied || abs.startsWith(denied + path.sep)) {
      return { allowed: false, reason: `POLICY_DENIED: "${abs}" is on the deny list (${denied})` };
    }
  }
  for (const root of resolvedRoots) {
    if (abs === root || abs.startsWith(root + path.sep)) {
      return { allowed: true, reason: 'allowed' };
    }
  }
  return {
    allowed: false,
    reason: `POLICY_DENIED: "${abs}" is outside every ${mode === 'write' ? 'writable' : 'readable'} root`,
  };
}

export function assertIsolationOrThrow(policy: IsolationPolicy, target: string, mode: 'read' | 'write'): void {
  const verdict = assertIsolationPolicy(policy, target, mode);
  if (!verdict.allowed) {
    throw new ExperimentError('POLICY_DENIED', verdict.reason, { fieldPaths: [target] });
  }
}

// ---------------------------------------------------------------------------
// Loading and validating a profile + its configs
// ---------------------------------------------------------------------------

function loadIsolationPolicy(absPath: string): IsolationPolicy {
  const raw = readJson(absPath, 'isolation policy');
  return {
    policyId: requireString(raw, 'policyId', 'isolationPolicy'),
    enforcement: requireString(raw, 'enforcement', 'isolationPolicy'),
    backend: (raw.backend ?? {}) as Record<string, unknown>,
    readableRoots: requireStringArray(raw, 'readableRoots', 'isolationPolicy'),
    writableRoots: requireStringArray(raw, 'writableRoots', 'isolationPolicy'),
    deniedPaths: requireStringArray(raw, 'deniedPaths', 'isolationPolicy'),
    deniedPathReasons: (raw.deniedPathReasons ?? {}) as Record<string, string>,
    requestCannotSupply: requireStringArray(raw, 'requestCannotSupply', 'isolationPolicy'),
  };
}

function loadEnvironmentPin(absPath: string): EnvironmentPin {
  const raw = readJson(absPath, 'environment pin');
  const interpreter = (raw.interpreter ?? {}) as Record<string, unknown>;
  const packageLock = (raw.packageLock ?? {}) as Record<string, unknown>;
  const framework = (raw.framework ?? {}) as Record<string, unknown>;
  const nodeInterpreter = (raw.nodeInterpreter ?? {}) as Record<string, unknown>;

  // SPEC section 5: "environment 记录解释器版本、包锁、框架/CUDA/驱动、设备及允许差异；
  // 机器相关信息不能只用 pythonPath 的 hash 代替." Each of those is required here.
  const pin: EnvironmentPin = {
    environmentId: requireString(raw, 'environmentId', 'environment'),
    device: requireString(raw, 'device', 'environment'),
    interpreter: {
      id: requireString(interpreter, 'id', 'environment.interpreter'),
      path: requireString(interpreter, 'path', 'environment.interpreter'),
      sha256: requireString(interpreter, 'sha256', 'environment.interpreter'),
      version: requireString(interpreter, 'version', 'environment.interpreter'),
      implementation: requireString(interpreter, 'implementation', 'environment.interpreter'),
    },
    nodeInterpreter: {
      id: requireString(nodeInterpreter, 'id', 'environment.nodeInterpreter'),
      path: requireString(nodeInterpreter, 'path', 'environment.nodeInterpreter'),
      sha256: requireString(nodeInterpreter, 'sha256', 'environment.nodeInterpreter'),
      version: requireString(nodeInterpreter, 'version', 'environment.nodeInterpreter'),
    },
    packageLock: {
      present: packageLock.present === true,
      kind: requireString(packageLock, 'kind', 'environment.packageLock'),
      command: requireString(packageLock, 'command', 'environment.packageLock'),
      normalization: requireString(packageLock, 'normalization', 'environment.packageLock'),
      packageCount: requireNumber(packageLock, 'packageCount', 'environment.packageLock'),
      sha256: requireString(packageLock, 'sha256', 'environment.packageLock'),
      honestLimitation: requireString(packageLock, 'honestLimitation', 'environment.packageLock'),
    },
    packages: (raw.packages ?? {}) as Record<string, string>,
    framework: {
      name: requireString(framework, 'name', 'environment.framework'),
      version: requireString(framework, 'version', 'environment.framework'),
      cudaBuild: requireString(framework, 'cudaBuild', 'environment.framework'),
      cudnn: requireString(framework, 'cudnn', 'environment.framework'),
      deterministicAlgorithmsSupported: framework.deterministicAlgorithmsSupported === true,
    },
    cuda: (raw.cuda ?? {}) as Record<string, unknown>,
    host: (raw.host ?? {}) as Record<string, unknown>,
    allowedDifferences: requireStringArray(raw, 'allowedDifferences', 'environment'),
    mustMatchExactly: requireStringArray(raw, 'mustMatchExactly', 'environment'),
  };

  if (!/^[0-9a-f]{64}$/.test(pin.interpreter.sha256)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'environment.interpreter.sha256 must be 64-char lowercase hex');
  }
  if (!/^[0-9a-f]{64}$/.test(pin.packageLock.sha256)) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      'environment.packageLock.sha256 must be 64-char lowercase hex: SPEC section 5 requires a recorded package lock'
    );
  }
  if (pin.packageLock.packageCount < 1) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'environment.packageLock.packageCount must be >= 1');
  }
  return pin;
}

function loadSlotSchemas(absPath: string, profile: TaskProfile): SlotSchemaSet {
  const raw = readJson(absPath, 'slot schema set');
  const schemas = (raw.schemas ?? {}) as Record<string, SlotSchema>;
  const set: SlotSchemaSet = { schemaSetId: requireString(raw, 'schemaSetId', 'slotSchemas'), schemas };

  for (const slot of profile.slots) {
    for (const [which, ref] of [
      ['input', slot.inputSchemaRef],
      ['output', slot.outputSchemaRef],
    ] as const) {
      const schema = schemas[ref];
      if (!schema) {
        throw new ExperimentError(
          'SCHEMA_VIOLATION',
          `slot "${slot.slotId}" declares ${which}SchemaRef "${ref}" but the slot schema set does not define it`,
          { fieldPaths: [`slots.${slot.slotId}.${which}SchemaRef`] }
        );
      }
      if (schema.direction !== which) {
        throw new ExperimentError(
          'SCHEMA_VIOLATION',
          `slot "${slot.slotId}" ${which}SchemaRef "${ref}" is declared direction "${schema.direction}"`,
          { fieldPaths: [ref] }
        );
      }
      if (!Array.isArray(schema.shape) || schema.shape.length !== 4) {
        throw new ExperimentError('SCHEMA_VIOLATION', `${ref}.shape must be a 4-element NCHW shape`, {
          fieldPaths: [ref],
        });
      }
      if (typeof schema.dtype !== 'string' || schema.dtype.length === 0) {
        throw new ExperimentError('SCHEMA_VIOLATION', `${ref}.dtype must name a concrete dtype`, { fieldPaths: [ref] });
      }
      if (typeof schema.device !== 'string' || schema.device.length === 0) {
        throw new ExperimentError('SCHEMA_VIOLATION', `${ref}.device must name a concrete device`, { fieldPaths: [ref] });
      }
      if (typeof schema.mask?.semantics !== 'string' || schema.mask.semantics.length === 0) {
        throw new ExperimentError('SCHEMA_VIOLATION', `${ref}.mask.semantics must state the mask semantics`, {
          fieldPaths: [ref],
        });
      }
      if (typeof schema.batch?.semantics !== 'string' || schema.batch.semantics.length === 0) {
        throw new ExperimentError('SCHEMA_VIOLATION', `${ref}.batch.semantics must state the batch semantics`, {
          fieldPaths: [ref],
        });
      }
      if (typeof schema.label?.semantics !== 'string' || schema.label.semantics.length === 0) {
        throw new ExperimentError('SCHEMA_VIOLATION', `${ref}.label.semantics must state the label semantics`, {
          fieldPaths: [ref],
        });
      }
    }
    if (!set.schemas[slot.inputSchemaRef].shape.every((n, i) => n === set.schemas[slot.outputSchemaRef].shape[i])) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `slot "${slot.slotId}" input and output shapes differ, but this profile's slot is shape-preserving`,
        { fieldPaths: [`slots.${slot.slotId}`] }
      );
    }
  }
  return set;
}

function loadOrderRules(absPath: string, profile: TaskProfile): OrderRuleSet {
  const raw = readJson(absPath, 'order rule set');
  const rules = (raw.rules ?? {}) as Record<string, OrderRule>;
  const set: OrderRuleSet = { ruleSetId: requireString(raw, 'ruleSetId', 'orderRules'), rules };
  for (const slot of profile.slots) {
    const rule = rules[slot.orderRuleRef];
    if (!rule) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `slot "${slot.slotId}" declares orderRuleRef "${slot.orderRuleRef}" but the order rule set does not define it`,
        { fieldPaths: [`slots.${slot.slotId}.orderRuleRef`] }
      );
    }
    if (rule.slotId !== slot.slotId) {
      throw new ExperimentError('SCHEMA_VIOLATION', `order rule "${slot.orderRuleRef}" names slot "${rule.slotId}"`, {
        fieldPaths: [slot.orderRuleRef],
      });
    }
    if (rule.maxModules !== profile.maxModules) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `order rule "${slot.orderRuleRef}" allows ${rule.maxModules} modules but profile "${profile.id}" declares maxModules=${profile.maxModules}`,
        { fieldPaths: ['maxModules'] }
      );
    }
  }
  return set;
}

export interface LoadProfileOptions {
  repoRoot?: string;
  profileId?: string;
  /** When true (default), the pinned runner script and interpreter digests are re-read from disk. */
  verifyPinsOnDisk?: boolean;
}

/**
 * Loads `configs/phase2/profile-cpu-seg-v1.json`, validates it against the frozen `TaskProfile`
 * contract, resolves its three refs to registered in-repo functions, and loads the environment pin,
 * isolation policy, slot schemas and order rules it points at.
 */
export function loadResolvedProfile(options: LoadProfileOptions = {}): ResolvedTaskProfile {
  const repoRoot = path.resolve(options.repoRoot ?? '.');
  const configDir = path.join(repoRoot, PHASE2_CONFIG_DIR);
  const registry = readJson(path.join(configDir, 'profile-registry.json'), 'profile registry') as unknown as ProfileRegistry;

  const profileId = options.profileId ?? PROFILE_ID;
  const entry = registry.profiles?.[profileId];
  if (!entry) {
    throw new ExperimentError('NOT_FOUND', `profile "${profileId}" is not registered in the host profile registry`, {
      fieldPaths: ['profileId'],
    });
  }

  const profile = validateTaskProfile(readJson(path.join(repoRoot, entry.profileFile), 'task profile'));
  if (profile.id !== profileId) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `registry entry "${profileId}" points at a profile whose id is "${profile.id}"`,
      { fieldPaths: ['id'] }
    );
  }
  if (profile.maxModules !== entry.pins.maxModules) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `profile "${profile.id}" declares maxModules=${profile.maxModules} but the host registry pins ${entry.pins.maxModules}`,
      { fieldPaths: ['maxModules'] }
    );
  }
  if (profile.sourceContractMax !== entry.pins.sourceContractMax) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `profile "${profile.id}" declares sourceContractMax=${profile.sourceContractMax} but the host registry pins ${entry.pins.sourceContractMax}`,
      { fieldPaths: ['sourceContractMax'] }
    );
  }

  // Resolve the three refs. A ref that is not in the registry is a hard failure: there is no
  // fallback runner, because a fallback is exactly how an arbitrary executable gets in.
  const resolveRef = (refString: string, kind: RegistryRef['kind']): RegistryRef => {
    const ref = entry.refs?.[refString];
    if (!ref) {
      throw new ExperimentError(
        'UNSUPPORTED_CAPABILITY',
        `profile "${profile.id}" declares ${kind}Ref "${refString}" but the host registry has no such ref`,
        { fieldPaths: [`${kind}Ref`] }
      );
    }
    if (ref.kind !== kind) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `ref "${refString}" is registered as kind "${ref.kind}" but was used as ${kind}Ref`,
        { fieldPaths: [`${kind}Ref`] }
      );
    }
    return ref;
  };

  const runnerRef = resolveRef(profile.runnerRef, 'runner');
  const compilerRef = resolveRef(profile.compilerRef, 'compiler');
  const verifierRef = resolveRef(profile.verifierRef, 'verifier');

  if (!runnerRef.script || !runnerRef.scriptSha256 || !runnerRef.interpreter || !runnerRef.argvTemplate) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `runner ref "${profile.runnerRef}" must pin a script, its sha256, an interpreter and an argv template`
    );
  }

  const scriptAbsPath = path.resolve(repoRoot, runnerRef.script);
  const interpreterAbsPath = path.resolve(runnerRef.interpreter.path);

  const environment = loadEnvironmentPin(path.join(repoRoot, entry.environmentRef));
  const isolation = loadIsolationPolicy(path.join(repoRoot, entry.isolationPolicyRef));
  const slotSchemas = loadSlotSchemas(path.join(repoRoot, entry.slotSchemaRef), profile);
  const orderRules = loadOrderRules(path.join(repoRoot, entry.orderRuleRef), profile);

  // The profile's isolationPolicyRef must name the policy the host actually loaded.
  if (toPosix(profile.isolationPolicyRef) !== toPosix(entry.isolationPolicyRef)) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `profile "${profile.id}" declares isolationPolicyRef "${profile.isolationPolicyRef}" but the registry resolves "${entry.isolationPolicyRef}"`,
      { fieldPaths: ['isolationPolicyRef'] }
    );
  }

  // The environment pin's device must be one the profile's capabilities actually claim, and the
  // profile must claim it: a profile that promises cpu while the environment says cuda is a defect.
  const deviceCapability = `device:${environment.device}`;
  if (!profile.capabilities.includes(deviceCapability)) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `environment declares device "${environment.device}" but profile "${profile.id}" does not claim capability "${deviceCapability}"`,
      { fieldPaths: ['capabilities'] }
    );
  }

  // The environment pin's interpreter must be the interpreter the registry runs.
  if (path.resolve(environment.interpreter.path) !== interpreterAbsPath) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `environment pin names interpreter "${environment.interpreter.path}" but the runner ref uses "${interpreterAbsPath}"`,
      { fieldPaths: ['environment.interpreter.path'] }
    );
  }

  if (options.verifyPinsOnDisk !== false) {
    if (!fs.existsSync(scriptAbsPath)) {
      throw new ExperimentError('PREFLIGHT_FAILED', `pinned runner script is missing: ${scriptAbsPath}`, {
        fieldPaths: [runnerRef.script],
      });
    }
    const actualScriptHash = sha256File(scriptAbsPath);
    if (actualScriptHash !== runnerRef.scriptSha256) {
      throw new ExperimentError(
        'SOURCE_MISMATCH',
        `pinned runner script hash mismatch: registry declares ${runnerRef.scriptSha256.slice(0, 12)}..., disk has ${actualScriptHash.slice(0, 12)}...`,
        { fieldPaths: [runnerRef.script] }
      );
    }
    if (!fs.existsSync(interpreterAbsPath)) {
      throw new ExperimentError('PREFLIGHT_FAILED', `pinned interpreter is missing: ${interpreterAbsPath}`, {
        fieldPaths: ['interpreter'],
      });
    }
    const actualInterpreterHash = sha256File(interpreterAbsPath);
    if (actualInterpreterHash !== runnerRef.interpreter.sha256) {
      throw new ExperimentError(
        'SOURCE_MISMATCH',
        `pinned interpreter hash mismatch: registry declares ${runnerRef.interpreter.sha256.slice(0, 12)}..., disk has ${actualInterpreterHash.slice(0, 12)}...`,
        { fieldPaths: ['interpreter'] }
      );
    }
  }

  // The pinned runner must be readable under the isolation policy, and it must NOT be writable.
  assertIsolationOrThrow(isolation, scriptAbsPath, 'read');
  const scriptWritable = assertIsolationPolicy(isolation, scriptAbsPath, 'write');
  if (scriptWritable.allowed) {
    throw new ExperimentError(
      'POLICY_DENIED',
      `the pinned runner script must not be writable: ${scriptAbsPath} falls inside a writable root`,
      { fieldPaths: ['isolationPolicy.writableRoots'] }
    );
  }

  // ---- Host-owned runtime pins ----
  const rawRuntime = (entry.runtime ?? {}) as unknown as Record<string, unknown>;
  const rawDataSpec = (rawRuntime.dataSpec ?? {}) as Record<string, unknown>;
  const dataSpec: RegistryRuntime['dataSpec'] = {
    kind: requireString(rawDataSpec, 'kind', 'runtime.dataSpec'),
    seed: requireNumber(rawDataSpec, 'seed', 'runtime.dataSpec'),
    sampleCount: requireNumber(rawDataSpec, 'sampleCount', 'runtime.dataSpec'),
    shape: (() => {
      const shape = rawDataSpec.shape;
      if (!Array.isArray(shape) || shape.length !== 3 || !shape.every((n) => typeof n === 'number' && n > 0)) {
        throw new ExperimentError('SCHEMA_VIOLATION', 'runtime.dataSpec.shape must be three positive numbers [C,H,W]', {
          fieldPaths: ['runtime.dataSpec.shape'],
        });
      }
      return shape as number[];
    })(),
    numClasses: requireNumber(rawDataSpec, 'numClasses', 'runtime.dataSpec'),
  };
  // A real slice is external bytes, so it carries a path AND the hash those
  // bytes must still have. Requiring both together is deliberate: a path with no
  // hash cannot be pinned, and a hash with no path pins nothing.
  if (rawDataSpec.slicePath !== undefined || rawDataSpec.sliceSha256 !== undefined) {
    if (rawDataSpec.kind !== 'real_slice') {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `runtime.dataSpec carries a slice path/hash but its kind is '${String(rawDataSpec.kind)}'`,
        { fieldPaths: ['runtime.dataSpec.slicePath'] },
      );
    }
    const slicePath = requireString(rawDataSpec, 'slicePath', 'runtime.dataSpec');
    const sliceSha256 = requireString(rawDataSpec, 'sliceSha256', 'runtime.dataSpec');
    if (!/^[0-9a-f]{64}$/.test(sliceSha256)) {
      throw new ExperimentError('SCHEMA_VIOLATION', 'runtime.dataSpec.sliceSha256 must be 64-char lowercase hex', {
        fieldPaths: ['runtime.dataSpec.sliceSha256'],
      });
    }
    dataSpec.slicePath = slicePath;
    dataSpec.sliceSha256 = sliceSha256;
  }
  const runtime: RegistryRuntime = {
    baselineImplementationPath: requireString(rawRuntime, 'baselineImplementationPath', 'runtime'),
    baselineImplementationSha256: requireString(rawRuntime, 'baselineImplementationSha256', 'runtime'),
    baseWeightPath: requireString(rawRuntime, 'baseWeightPath', 'runtime'),
    baseWeightSha256: requireString(rawRuntime, 'baseWeightSha256', 'runtime'),
    timeoutMs: requireNumber(rawRuntime, 'timeoutMs', 'runtime'),
    learningRate: requireNumber(rawRuntime, 'learningRate', 'runtime'),
    batchSize: requireNumber(rawRuntime, 'batchSize', 'runtime'),
    slotChannels: requireNumber(rawRuntime, 'slotChannels', 'runtime'),
    dataSpec,
    note: requireString(rawRuntime, 'note', 'runtime'),
  };
  if (runtime.timeoutMs <= 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'runtime.timeoutMs must be positive', {
      fieldPaths: ['runtime.timeoutMs'],
    });
  }
  if (!/^[0-9a-f]{64}$/.test(runtime.baselineImplementationSha256)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'runtime.baselineImplementationSha256 must be 64-char lowercase hex');
  }
  if (!/^[0-9a-f]{64}$/.test(runtime.baseWeightSha256)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'runtime.baseWeightSha256 must be 64-char lowercase hex');
  }

  const prePoolSlot = profile.slots.find((s) => s.slotId === 'features.pre_pool') ?? profile.slots[0];
  const prePoolSchema = slotSchemas.schemas[prePoolSlot.outputSchemaRef];
  if (prePoolSchema.shape[0] !== runtime.batchSize) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `slot schema ${prePoolSlot.outputSchemaRef} declares batch ${prePoolSchema.shape[0]} but runtime.batchSize is ${runtime.batchSize}`,
      { fieldPaths: ['runtime.batchSize'] }
    );
  }
  // The slot sits AFTER the baseline's Conv2d(3->8, k=3, p=1), so its channel count is the
  // baseline's post-conv width, not the dataset's input channel count. runtime.slotChannels pins
  // that width so a slot-schema edit cannot silently disagree with the baseline topology.
  if (prePoolSchema.shape[1] !== runtime.slotChannels) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `slot schema ${prePoolSlot.outputSchemaRef} declares ${prePoolSchema.shape[1]} channels but runtime.slotChannels is ${runtime.slotChannels}`,
      { fieldPaths: ['runtime.slotChannels'] }
    );
  }

  const rawModules = entry.pinnedModules;
  if (!Array.isArray(rawModules) || rawModules.length === 0) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      'the host registry must pin at least one module source; a profile with no pinned modules could only ever run the baseline',
      { fieldPaths: ['pinnedModules'] }
    );
  }
  if (rawModules.length > profile.maxModules) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `the host registry pins ${rawModules.length} module sources but profile "${profile.id}" supports at most ${profile.maxModules}`,
      { fieldPaths: ['pinnedModules'] }
    );
  }
  const pinnedModules: PinnedModule[] = rawModules.map((raw, i) => {
    const m = raw as unknown as Record<string, unknown>;
    const context = `pinnedModules[${i}]`;
    const implementationPath = path.resolve(repoRoot, requireString(m, 'implementationPath', context));
    const module: PinnedModule = {
      id: requireString(m, 'id', context),
      className: requireString(m, 'className', context),
      implementationPath,
      sha256: requireString(m, 'sha256', context),
      mechanismKind: requireString(m, 'mechanismKind', context),
    };
    if (!/^[0-9a-f]{64}$/.test(module.sha256)) {
      throw new ExperimentError('SCHEMA_VIOLATION', `${context}.sha256 must be 64-char lowercase hex`);
    }
    const allowedKinds = prePoolSlot.allowedModuleKinds as readonly string[];
    if (!allowedKinds.includes(module.mechanismKind)) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `pinned module "${module.id}" declares mechanismKind "${module.mechanismKind}" but slot "${prePoolSlot.slotId}" allows ${allowedKinds.join(', ')}`,
        { fieldPaths: [`slots.${prePoolSlot.slotId}.allowedModuleKinds`] }
      );
    }
    const declaredSlots = m.slotIds;
    if (Array.isArray(declaredSlots) && !(declaredSlots as string[]).includes(prePoolSlot.slotId)) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `pinned module "${module.id}" declares slotIds ${(declaredSlots as string[]).join(', ')} which does not include "${prePoolSlot.slotId}"`,
        { fieldPaths: [`pinnedModules[${i}].slotIds`] }
      );
    }
    return module;
  });
  if (new Set(pinnedModules.map((m) => m.id)).size !== pinnedModules.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'pinnedModules ids must be unique', {
      fieldPaths: ['pinnedModules'],
    });
  }

  const baselineImplementationPath = path.resolve(repoRoot, runtime.baselineImplementationPath);
  const baseWeightPath = path.resolve(repoRoot, runtime.baseWeightPath);
  assertIsolationOrThrow(isolation, baselineImplementationPath, 'read');
  assertIsolationOrThrow(isolation, baseWeightPath, 'read');
  for (const module of pinnedModules) assertIsolationOrThrow(isolation, module.implementationPath, 'read');

  const verifyPinsOnDisk = options.verifyPinsOnDisk !== false;
  if (verifyPinsOnDisk) {
    const baselineHash = sha256File(baselineImplementationPath);
    if (baselineHash !== runtime.baselineImplementationSha256) {
      throw new ExperimentError(
        'SOURCE_MISMATCH',
        `pinned baseline hash mismatch: registry declares ${runtime.baselineImplementationSha256.slice(0, 12)}..., disk has ${baselineHash.slice(0, 12)}...`,
        { fieldPaths: ['runtime.baselineImplementationSha256'] }
      );
    }
    if (fs.existsSync(baseWeightPath)) {
      const weightHash = sha256File(baseWeightPath);
      if (weightHash !== runtime.baseWeightSha256) {
        throw new ExperimentError(
          'SOURCE_MISMATCH',
          `pinned baseline weight hash mismatch: registry declares ${runtime.baseWeightSha256.slice(0, 12)}..., disk has ${weightHash.slice(0, 12)}...`,
          { fieldPaths: ['runtime.baseWeightSha256'] }
        );
      }
    }
    for (const module of pinnedModules) {
      if (!fs.existsSync(module.implementationPath)) {
        throw new ExperimentError('NOT_FOUND', `pinned module implementation is missing: ${module.implementationPath}`, {
          fieldPaths: [`pinnedModules.${module.id}`],
        });
      }
      const actual = sha256File(module.implementationPath);
      if (actual !== module.sha256) {
        throw new ExperimentError(
          'SOURCE_MISMATCH',
          `pinned module "${module.id}" hash mismatch: registry declares ${module.sha256.slice(0, 12)}..., disk has ${actual.slice(0, 12)}...`,
          { fieldPaths: [`pinnedModules.${module.id}`] }
        );
      }
    }
  }

  return {
    profile,
    profileRef: `${profile.id}@${profile.version}`,
    registry,
    entry,
    environment,
    isolation,
    slotSchemas,
    orderRules,
    runner: {
      ref: runnerRef,
      scriptAbsPath,
      scriptSha256: runnerRef.scriptSha256,
      interpreterAbsPath,
      interpreterSha256: runnerRef.interpreter.sha256,
      interpreterVersion: runnerRef.interpreter.version,
    },
    compiler: compilerRef,
    verifier: verifierRef,
    pinnedModules,
    baselineImplementationPath,
    baseWeightPath,
    timeoutMs: runtime.timeoutMs,
    learningRate: runtime.learningRate,
    batchSize: runtime.batchSize,
    dataSpec: runtime.dataSpec,
    verifyModuleHashesOnDisk: verifyPinsOnDisk,
    repoRoot,
    configDir,
  };
}

// ---------------------------------------------------------------------------
// 1. compileRecipe(implementation, bindings)
// ---------------------------------------------------------------------------

/** One pinned module the host is willing to place in a slot. Supplied by the host, never by a request. */
export interface PinnedModule {
  id: string;
  className: string;
  /** Absolute path to the module implementation. Host-resolved from a pinned source. */
  implementationPath: string;
  /** sha256 of the implementation file, verified before the recipe is emitted. */
  sha256: string;
  mechanismKind: string;
}

export interface ImplementationRef {
  /** Content identity of the implementation the bindings describe. */
  implementationHash: string;
  /** Where the implementation's module sources live. Used for the source check, not for execution. */
  codeTreeRef?: string;
}

export interface PlanBindingLike {
  slotId: string;
  orderedModuleIds: string[];
  configRef: string;
}

export interface CompiledRecipeModule {
  id: string;
  className: string;
  implementationPath: string;
  sha256: string;
  mechanismKind: string;
  position: number;
}

export interface CompiledRecipe {
  schemaVersion: number;
  variant: string;
  slotId: string;
  modules: CompiledRecipeModule[];
  /** The declared order, echoed so a verifier can compare observed order against intent. */
  declaredOrder: string[];
  profileRef: string;
  recipeHash: string;
}

/**
 * SPEC section 5: `compileRecipe(implementation, bindings)`.
 *
 * Builds a variant recipe from module ids + bindings. There is deliberately NO A/B name handling:
 * the variant selects a PREFIX of the binding's declared `orderedModuleIds`, so adding a third
 * module works without touching this function, and the order is whatever the binding said.
 */
export function compileRecipe(
  resolved: ResolvedTaskProfile,
  implementation: ImplementationRef,
  bindings: readonly PlanBindingLike[],
  variant: string
): CompiledRecipe {
  if (typeof variant !== 'string' || variant.length === 0) {
    throw new ExperimentError('INVALID_INPUT', 'variant must be a non-empty string', { fieldPaths: ['variant'] });
  }
  if (bindings.length === 0) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', 'compileRecipe needs at least one binding', {
      fieldPaths: ['bindings'],
    });
  }
  if (bindings.length > 1) {
    throw new ExperimentError(
      'UNSUPPORTED_CAPABILITY',
      `profile "${resolved.profile.id}" declares ${resolved.profile.slots.length} slot(s); ${bindings.length} bindings were supplied`,
      { fieldPaths: ['bindings'] }
    );
  }

  const binding = bindings[0];
  const slot: SlotContract | undefined = resolved.profile.slots.find((s) => s.slotId === binding.slotId);
  if (!slot) {
    // SPEC section 6: an unsupported slot must be reported, never coerced onto features.pre_pool.
    throw new ExperimentError(
      'INCOMPATIBLE_BINDING',
      `slot "${binding.slotId}" is not declared by profile "${resolved.profile.id}"; declared slots: ${resolved.profile.slots
        .map((s) => s.slotId)
        .join(', ')}. An unknown slot is refused, not coerced onto an existing one.`,
      { fieldPaths: ['bindings[0].slotId'] }
    );
  }

  const orderRule = resolved.orderRules.rules[slot.orderRuleRef];
  if (!orderRule) {
    throw new ExperimentError('SCHEMA_VIOLATION', `slot "${slot.slotId}" has no order rule`, {
      fieldPaths: [`slots.${slot.slotId}.orderRuleRef`],
    });
  }
  if (binding.orderedModuleIds.length > resolved.profile.maxModules) {
    throw new ExperimentError(
      'INCOMPATIBLE_BINDING',
      `binding declares ${binding.orderedModuleIds.length} modules but profile "${resolved.profile.id}" supports at most ${resolved.profile.maxModules} (the frozen P6 v1 cap)`,
      { fieldPaths: ['bindings[0].orderedModuleIds'] }
    );
  }
  if (new Set(binding.orderedModuleIds).size !== binding.orderedModuleIds.length) {
    throw new ExperimentError(
      'INCOMPATIBLE_BINDING',
      `binding declares a duplicate module id: ${binding.orderedModuleIds.join(', ')}`,
      { fieldPaths: ['bindings[0].orderedModuleIds'] }
    );
  }

  // Variant selects a PREFIX of the declared order. No name matching, no letter matching.
  let count: number;
  if (variant === 'baseline') {
    count = 0;
  } else if (/^[a-z]+$/.test(variant)) {
    count = variant.length;
  } else {
    throw new ExperimentError(
      'INVALID_INPUT',
      `variant "${variant}" must be "baseline" or a run of lowercase letters naming a prefix length (a, ab, abc)`,
      { fieldPaths: ['variant'] }
    );
  }
  if (count > binding.orderedModuleIds.length) {
    throw new ExperimentError(
      'INCOMPATIBLE_BINDING',
      `variant "${variant}" names ${count} module position(s) but the binding declares ${binding.orderedModuleIds.length}`,
      { fieldPaths: ['variant'] }
    );
  }

  const selectedIds = binding.orderedModuleIds.slice(0, count);
  const modules: CompiledRecipeModule[] = selectedIds.map((moduleId, position) => {
    const pinned = resolved.pinnedModules.find((m) => m.id === moduleId);
    if (!pinned) {
      throw new ExperimentError(
        'NOT_FOUND',
        `module id "${moduleId}" is not a host-pinned module source for profile "${resolved.profile.id}"; a request cannot introduce a module by path`,
        { fieldPaths: [`bindings[0].orderedModuleIds[${position}]`] }
      );
    }
    if (!slot.allowedModuleKinds.includes(pinned.mechanismKind as never)) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `module "${moduleId}" declares mechanism kind "${pinned.mechanismKind}", which slot "${slot.slotId}" does not allow (allowed: ${slot.allowedModuleKinds.join(', ')})`,
        { fieldPaths: [`slots.${slot.slotId}.allowedModuleKinds`] }
      );
    }
    if (resolved.verifyModuleHashesOnDisk) {
      if (!fs.existsSync(pinned.implementationPath)) {
        throw new ExperimentError('NOT_FOUND', `module implementation is missing: ${pinned.implementationPath}`, {
          fieldPaths: [`modules.${moduleId}`],
        });
      }
      const actual = sha256File(pinned.implementationPath);
      if (actual !== pinned.sha256) {
        throw new ExperimentError(
          'SOURCE_MISMATCH',
          `module "${moduleId}" hash mismatch: host pins ${pinned.sha256.slice(0, 12)}..., disk has ${actual.slice(0, 12)}...`,
          { fieldPaths: [`modules.${moduleId}`] }
        );
      }
    }
    return {
      id: pinned.id,
      className: pinned.className,
      implementationPath: toPosix(pinned.implementationPath),
      sha256: pinned.sha256,
      mechanismKind: pinned.mechanismKind,
      position,
    };
  });

  const core = {
    schemaVersion: 1,
    variant,
    slotId: slot.slotId,
    modules,
    declaredOrder: [...binding.orderedModuleIds],
    profileRef: `${resolved.profile.id}@${resolved.profile.version}`,
    implementationHash: implementation.implementationHash,
    configRef: binding.configRef,
    orderRuleRef: slot.orderRuleRef,
  };

  return {
    ...core,
    recipeHash: crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex'),
  } as CompiledRecipe;
}

// ---------------------------------------------------------------------------
// 2. prepareRun(protocol, variant, seed)
// ---------------------------------------------------------------------------

export interface PreparedRun {
  schemaVersion: number;
  runId: string;
  variant: string;
  seed: number;
  stage: string;
  profileRef: string;
  profileVersion: number;
  /** The argv is built from the host registry. A request never contributes an element. */
  argv: string[];
  cwd: string;
  /** The host-built manifest body. Written to disk by `materializeManifest`. */
  manifest: Record<string, unknown>;
  /** Identity hash of the manifest BODY (compact canonical form). This is what the runner echoes. */
  manifestHash: string;
  /** sha256 of the manifest file bytes as materialized. Integrity only; set by materializeManifest. */
  manifestFileSha256: string | null;
  outputDir: string;
  timeoutMs: number;
  environmentRef: string;
  isolationPolicyRef: string;
}

export interface PrepareRunOptions {
  /** Unique per execution so a rerun is never mistaken for a cache hit. */
  runNonce: string;
  outputDir: string;
  bindings: readonly PlanBindingLike[];
  implementation: ImplementationRef;
  /** Optional pin for the baseline weights; when absent the runner creates and saves them. */
  baseWeightPath?: string | null;
}

function assertProtocolMatchesProfile(resolved: ResolvedTaskProfile, protocol: LightweightProtocol): void {
  if (protocol.profileRef !== resolved.profile.id && protocol.profileRef !== resolved.profileRef) {
    throw new ExperimentError(
      'INCOMPATIBLE_BINDING',
      `protocol.profileRef "${protocol.profileRef}" does not name profile "${resolved.profile.id}"`,
      { fieldPaths: ['protocol.profileRef'] }
    );
  }
  const recomputed = computeLightweightProtocolHash(lightweightProtocolBody(protocol));
  if (recomputed !== protocol.protocolHash) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'protocol hash does not match its body', {
      fieldPaths: ['protocol.protocolHash'],
    });
  }
  if (!protocol.seeds.includes(0) && protocol.seeds.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'protocol declares no seed', { fieldPaths: ['protocol.seeds'] });
  }
}

/**
 * SPEC section 5: `prepareRun(protocol, variant, seed)`.
 *
 * Builds everything needed to start one real run: a run identity, the argv from the host registry,
 * a manifest bound to implementation/profile/data/config/environment/seed/variant/stage/budget, and
 * the output directory. It does not start the process — `runPrepared` does, and
 * `runPhase2CpuSegRunner` is the registered `runnerRef` implementation.
 */
export function prepareRun(
  resolved: ResolvedTaskProfile,
  protocol: LightweightProtocol,
  variant: string,
  seed: number,
  options: PrepareRunOptions
): PreparedRun {
  assertProtocolMatchesProfile(resolved, protocol);

  if (!Number.isFinite(seed) || seed < 0) {
    throw new ExperimentError('INVALID_INPUT', 'seed must be a finite number >= 0', { fieldPaths: ['seed'] });
  }
  if (!protocol.seeds.includes(seed)) {
    throw new ExperimentError(
      'INVALID_INPUT',
      `seed ${seed} is not declared by the protocol (declared: ${protocol.seeds.join(', ')})`,
      { fieldPaths: ['seed'] }
    );
  }
  if (!protocol.variants.includes(variant)) {
    throw new ExperimentError(
      'INVALID_INPUT',
      `variant "${variant}" is not declared by the protocol (declared: ${protocol.variants.join(', ')})`,
      { fieldPaths: ['variant'] }
    );
  }
  if (!options.runNonce || typeof options.runNonce !== 'string') {
    throw new ExperimentError('INVALID_INPUT', 'runNonce is required so a rerun takes a new identity', {
      fieldPaths: ['runNonce'],
    });
  }

  const outputDir = path.resolve(options.outputDir);
  assertIsolationOrThrow(resolved.isolation, outputDir, 'write');

  const compiled = compileRecipe(resolved, options.implementation, options.bindings, variant);
  if (variant === 'baseline' && compiled.modules.length !== 0) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', 'the baseline variant may not carry modules', {
      fieldPaths: ['variant'],
    });
  }
  if (variant !== 'baseline' && compiled.modules.length === 0) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', `variant "${variant}" carries no modules`, {
      fieldPaths: ['variant'],
    });
  }
  if (variant !== 'baseline' && compiled.modules.length !== variant.length) {
    throw new ExperimentError(
      'INCOMPATIBLE_BINDING',
      `variant "${variant}" names ${variant.length} module position(s) but the compiled recipe carries ${compiled.modules.length}`,
      { fieldPaths: ['variant'] }
    );
  }

  const runId = `run-${variant}-s${seed}-${options.runNonce}`;
  // A host-owned diagnostic override, never a request field: the cancellation
  // evidence needs a child that is still alive when the cancel arrives. A
  // sweep whose arms finish in under a second can be "cancelled" without
  // anything ever having been killed, which proves nothing. The override only
  // exists to make the kill observable; unset, the timeout is the profile's.
  const timeoutOverride = Number(process.env.DSH_EVAL_CANCEL_PROBE_TIMEOUT_MS ?? '');
  const timeoutMs = Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : resolved.timeoutMs;
  const stage = protocol.metricSpecs.length > 0 ? 'tiny' : 'smoke';
  const manifestPath = path.join(outputDir, 'manifest.json');
  // The weights path defaults to the host pin. A caller may override it only to point at another
  // in-repo file; it may not introduce an executable, and the path is resolved and policy-checked.
  const baseWeightPath =
    options.baseWeightPath === undefined
      ? resolved.baseWeightPath
      : options.baseWeightPath === null
        ? null
        : path.resolve(options.baseWeightPath);
  if (baseWeightPath !== null) {
    assertIsolationOrThrow(resolved.isolation, baseWeightPath, 'read');
  }

  const manifestBody: Record<string, unknown> = {
    schemaVersion: 1,
    runId,
    variant,
    seed,
    stage,
    lr: resolved.learningRate,
    batchSize: resolved.batchSize,
    limit: protocol.limit,
    outputDir: toPosix(outputDir),
    manifestPath: toPosix(manifestPath),
    dataSpec: resolved.dataSpec,
    baselineImplementationPath: toPosix(resolved.baselineImplementationPath),
    baseWeightPath: baseWeightPath ? toPosix(baseWeightPath) : null,
    environment: {
      device: resolved.environment.device,
      interpreter: resolved.runner.interpreterAbsPath,
      interpreterSha256: resolved.environment.interpreter.sha256,
      interpreterVersion: resolved.environment.interpreter.version,
      pythonImplementation: resolved.environment.interpreter.implementation,
      framework: resolved.environment.framework.name,
      frameworkVersion: resolved.environment.framework.version,
      cudaBuild: resolved.environment.framework.cudaBuild,
      cudaAvailableOnHost: resolved.environment.cuda.availableOnHost === true,
      driverVersion: resolved.environment.cuda.driverVersion ?? null,
      deviceName: resolved.environment.cuda.deviceName ?? null,
      packageLockSha256: resolved.environment.packageLock.sha256,
      packageLockPackageCount: resolved.environment.packageLock.packageCount,
      packageLockKind: resolved.environment.packageLock.kind,
      profileRef: protocol.profileRef,
    },
    protocolHash: protocol.protocolHash,
    recipe: compiled,
    implementationHash: options.implementation.implementationHash,
    timeoutMs,
    createdAt: new Date().toISOString(),
  };

  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');
  const manifest = { ...manifestBody, manifestHash };

  return {
    schemaVersion: 1,
    runId,
    variant,
    seed,
    stage,
    profileRef: `${resolved.profile.id}@${resolved.profile.version}`,
    profileVersion: resolved.profile.version,
    // argv is built ONLY from the registry's template. <interpreter>, <script> and <manifestPath>
    // are substituted from host-owned values; literal elements (like "--manifest") pass through.
    // No element of this array comes from a request.
    argv: resolved.runner.ref.argvTemplate!.map((part) => {
      if (part === '<interpreter>') return resolved.runner.interpreterAbsPath;
      if (part === '<script>') return resolved.runner.scriptAbsPath;
      if (part === '<manifestPath>') return manifestPath;
      if (part.startsWith('<') && part.endsWith('>')) {
        throw new ExperimentError(
          'POLICY_DENIED',
          `the runner argv template contains an unknown placeholder "${part}"; only <interpreter>, <script> and <manifestPath> are understood`,
          { fieldPaths: ['argvTemplate'] }
        );
      }
      return part;
    }),
    cwd: resolved.repoRoot,
    manifest,
    manifestHash,
    manifestFileSha256: null,
    outputDir,
    timeoutMs,
    environmentRef: resolved.entry.environmentRef,
    isolationPolicyRef: resolved.entry.isolationPolicyRef,
  };
}

/** Writes the prepared manifest to disk inside the run's output directory. */
export function materializeManifest(prepared: PreparedRun, resolved: ResolvedTaskProfile): string {
  assertIsolationOrThrow(resolved.isolation, prepared.outputDir, 'write');
  fs.mkdirSync(prepared.outputDir, { recursive: true });
  const manifestPath = path.join(prepared.outputDir, 'manifest.json');
  // The manifest is written exactly as hashed in prepareRun: adding a field here would change the
  // body and break the manifestHash identity the runner echoes back in raw-result.json.
  const bytes = `${JSON.stringify(prepared.manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, bytes, 'utf8');
  prepared.manifestFileSha256 = crypto.createHash('sha256').update(bytes, 'utf8').digest('hex');
  return manifestPath;
}

// ---------------------------------------------------------------------------
// 3. verifyRun(manifest, facts, artifacts)
// ---------------------------------------------------------------------------

export interface RunFacts {
  runId: string;
  manifestHash: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  rawResultPath: string | null;
  completedAt: string;
  /** Present on search-root runs guarded by the host resource monitor. */
  peakWorkingSetBytes?: number;
  /** Bytes found beneath this run's output directory after process exit. */
  outputBytes?: number;
  resourceSampleCount?: number;
  resourceLimitExceeded?: string | null;
}

export interface RunArtifacts {
  /**
   * sha256 of the manifest FILE BYTES on disk. This is an artifact-integrity value, not the run
   * identity: the identity is `manifestHash`, which is computed over the compact canonical body.
   * Keeping the two separate is deliberate — conflating them would make the identity check depend
   * on JSON pretty-printing.
   */
  manifestFileSha256: string;
  /** sha256 of raw-result.json bytes. */
  rawResultFileSha256: string;
  /** sha256 of each module implementation the recipe named, keyed by module id. */
  moduleFileSha256: Record<string, string>;
}

export interface ModuleVerdict {
  moduleId: string;
  position: number;
  mechanismKind: string;
  executionCount: number;
  maxGradNorm: number;
  parameterUpdated: boolean;
  parameterCount: number;
  isParameterFree: boolean;
  /** How the mechanism check must read this module. */
  checkKind: 'parameterized_feature' | 'parameter_free_operator';
  status: 'passed' | 'failed';
  reason: string;
}

export interface VerifiedRun {
  schemaVersion: number;
  runId: string;
  variant: string;
  stage: string;
  seed: number;
  profileRef: string;
  manifestHash: string;
  rawResultFileSha256: string;
  status: 'verified';
  stepsCompleted: number;
  sampleCount: number;
  batchSize: number;
  initialLoss: number;
  finalLoss: number;
  metrics: Record<string, { value: number; unit: string; split: string; sampleCount: number }>;
  modules: ModuleVerdict[];
  environmentObserved: Record<string, unknown>;
  wallTimeMs: number;
  /** What this verification did NOT cover. Recorded rather than silently omitted. */
  declaredGaps: string[];
  verifiedAt: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * SPEC section 5: `verifyRun(manifest, facts, artifacts)`.
 *
 * Host-side verification. The process's own stdout is never the evidence: a non-zero exit, a
 * timeout, a run-id mismatch or a manifest-hash mismatch is refused before any number is read.
 *
 * NOTE ON ASSERTIONS: this profile declares its OWN assertions. It does not inherit and does not
 * weaken the stitch-cpu-v1 host verifier's 16-sample / 4x2-logit / 5-step assertions, and it does
 * not apply them either: this profile's declared limit comes from the protocol, its logits width
 * comes from the manifest's batchSize and the slot schema's numClasses, and the sample count comes
 * from the manifest's dataSpec.
 */
export function verifyRun(
  resolved: ResolvedTaskProfile,
  prepared: PreparedRun,
  facts: RunFacts,
  artifacts: RunArtifacts
): VerifiedRun {
  // ---- (a) Process facts beat any self-report. ----
  if (facts.resourceLimitExceeded) {
    throw new ExperimentError('BUDGET_EXHAUSTED', `resource guard stopped run ${facts.runId}: ${facts.resourceLimitExceeded}`, {
      fieldPaths: ['rootBudget.maxMemoryBytes', 'rootBudget.maxDiskBytes'],
    });
  }
  if (facts.timedOut) {
    throw new ExperimentError('RUN_TIMEOUT', `run ${facts.runId} timed out after ${facts.durationMs}ms`, {
      fieldPaths: ['timeoutMs'],
    });
  }
  if (facts.exitCode !== 0) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `run ${facts.runId} exited with code ${facts.exitCode}; stdout claims cannot override the exit status. stderr tail: ${facts.stderrTail}`,
      { fieldPaths: ['exitCode'] }
    );
  }
  if (facts.durationMs > prepared.timeoutMs) {
    throw new ExperimentError(
      'RUN_TIMEOUT',
      `run ${facts.runId} reported ${facts.durationMs}ms, above the declared per-attempt budget ${prepared.timeoutMs}ms`,
      { fieldPaths: ['timeoutMs'] }
    );
  }
  if (facts.runId !== prepared.runId) {
    throw new ExperimentError('INVALID_RESULT', `facts describe run "${facts.runId}" but "${prepared.runId}" was prepared`, {
      fieldPaths: ['runId'],
    });
  }
  if (facts.manifestHash !== prepared.manifestHash) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `facts carry manifest hash ${facts.manifestHash.slice(0, 12)}... but the prepared manifest hashes to ${prepared.manifestHash.slice(0, 12)}...`,
      { fieldPaths: ['manifestHash'] }
    );
  }

  // ---- (b) Artifact identity: the bytes on disk must match what we think we ran. ----
  // `facts.manifestHash` is the run IDENTITY (a hash of the manifest body). `artifacts.manifestFileSha256`
  // is the hash of the manifest FILE. They are different values by construction; what must hold is
  // that the file we re-read still has the bytes we materialized, and that the manifest body those
  // bytes describe still hashes to the identity the runner echoed.
  if (prepared.manifestFileSha256 !== null && artifacts.manifestFileSha256 !== prepared.manifestFileSha256) {
    throw new ExperimentError(
      'ARTIFACT_CORRUPT',
      `the manifest file on disk hashes to ${artifacts.manifestFileSha256.slice(0, 12)}... but the materialized manifest hashed to ${prepared.manifestFileSha256.slice(0, 12)}...`,
      { fieldPaths: ['manifestFileSha256'] }
    );
  }
  const { manifestHash: _declaredHash, ...manifestBody } = prepared.manifest;
  const recomputedBodyHash = crypto.createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');
  if (recomputedBodyHash !== prepared.manifestHash) {
    throw new ExperimentError(
      'ARTIFACT_CORRUPT',
      `the manifest body re-hashes to ${recomputedBodyHash.slice(0, 12)}... but its declared identity is ${prepared.manifestHash.slice(0, 12)}...`,
      { fieldPaths: ['manifestHash'] }
    );
  }
  for (const module of (prepared.manifest.recipe as CompiledRecipe).modules) {
    const observed = artifacts.moduleFileSha256[module.id];
    if (observed !== module.sha256) {
      throw new ExperimentError(
        'SOURCE_MISMATCH',
        `module "${module.id}" changed between compile and verify: recipe pinned ${module.sha256.slice(0, 12)}..., disk has ${String(observed).slice(0, 12)}...`,
        { fieldPaths: [`modules.${module.id}`] }
      );
    }
  }

  if (!facts.rawResultPath) {
    throw new ExperimentError('INVALID_RESULT', `run ${facts.runId} produced no raw-result.json`, {
      fieldPaths: ['rawResultPath'],
    });
  }
  if (!fs.existsSync(facts.rawResultPath)) {
    throw new ExperimentError('ARTIFACT_CORRUPT', `raw result is missing at ${facts.rawResultPath}`, {
      fieldPaths: ['rawResultPath'],
    });
  }
  const rawText = fs.readFileSync(facts.rawResultPath, 'utf8');
  const observedRawHash = crypto.createHash('sha256').update(rawText).digest('hex');
  if (observedRawHash !== artifacts.rawResultFileSha256) {
    throw new ExperimentError(
      'ARTIFACT_CORRUPT',
      `raw-result.json hashes to ${observedRawHash.slice(0, 12)}... but the caller registered ${artifacts.rawResultFileSha256.slice(0, 12)}...`,
      { fieldPaths: ['rawResultFileSha256'] }
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch (err) {
    throw new ExperimentError('INVALID_RESULT', `raw-result.json is not valid JSON: ${String(err)}`, {
      fieldPaths: ['rawResultPath'],
    });
  }

  // ---- (c) The self-report must agree with the identity we prepared. ----
  if (raw.runId !== prepared.runId) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `raw result names run "${String(raw.runId)}" but this run is "${prepared.runId}"`,
      { fieldPaths: ['runId'] }
    );
  }
  if (raw.manifestHash !== prepared.manifestHash) {
    throw new ExperimentError('INVALID_RESULT', 'raw result manifest hash does not match the executed manifest', {
      fieldPaths: ['manifestHash'],
    });
  }
  if (raw.status !== 'succeeded') {
    throw new ExperimentError(
      'INVALID_RESULT',
      `raw result reported status "${String(raw.status)}" despite exit code 0`,
      { fieldPaths: ['status'] }
    );
  }
  if (raw.variant !== prepared.variant) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `raw result ran variant "${String(raw.variant)}" but "${prepared.variant}" was prepared`,
      { fieldPaths: ['variant'] }
    );
  }
  if (raw.seed !== prepared.seed) {
    throw new ExperimentError('INVALID_RESULT', `raw result seed ${String(raw.seed)} != prepared seed ${prepared.seed}`, {
      fieldPaths: ['seed'],
    });
  }

  // ---- (d) Declared budget: steps completed must equal the declared limit. ----
  const limit = prepared.manifest.limit as { kind: string; value: number };
  const stepsCompleted = raw.stepsCompleted;
  if (!isFiniteNumber(stepsCompleted)) {
    throw new ExperimentError('INVALID_RESULT', 'raw result reports no finite stepsCompleted', {
      fieldPaths: ['stepsCompleted'],
    });
  }
  if (limit.kind === 'steps' && stepsCompleted !== limit.value) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `raw result completed ${stepsCompleted} steps but the manifest declared ${limit.value}`,
      { fieldPaths: ['stepsCompleted'] }
    );
  }
  if (limit.kind === 'wall_time' && stepsCompleted < 1) {
    throw new ExperimentError('INVALID_RESULT', 'a wall_time run must record at least one completed step', {
      fieldPaths: ['stepsCompleted'],
    });
  }

  // ---- (e) This profile's OWN structural assertions. ----
  //
  // These are read from the manifest and the slot schema, not hardcoded. This profile deliberately
  // does NOT inherit stitch-cpu-v1's assertions (16 samples / 4x2 logits / 5 steps): its sample
  // count, batch size, step limit and class count all come from the manifest, so the same code
  // checks a 2-step smoke and a 5-step tiny run without either one being privileged.
  //
  // DECLARED GAP: experiments/phase2-cpu-seg-v1/runner.py does not report `finalLogits`, so this
  // verifier cannot host-check logits VALUES. It is recorded as a gap below rather than papered
  // over with a weaker check. If the runner ever starts reporting logits, the shape/finiteness
  // assertion below activates automatically.
  const batchSize = prepared.manifest.batchSize as number;
  const dataSpec = prepared.manifest.dataSpec as { sampleCount: number; numClasses: number };
  const slot = resolved.profile.slots[0];
  const outputSchema = resolved.slotSchemas.schemas[slot.outputSchemaRef];

  if (raw.batchSize !== batchSize) {
    throw new ExperimentError('INVALID_RESULT', `raw result batchSize ${String(raw.batchSize)} != declared ${batchSize}`, {
      fieldPaths: ['batchSize'],
    });
  }
  if (raw.sampleCount !== dataSpec.sampleCount) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `raw result sampleCount ${String(raw.sampleCount)} != declared ${dataSpec.sampleCount}`,
      { fieldPaths: ['sampleCount'] },
    );
  }

  // Per-step metrics are the runner's real evidence trail: there must be exactly one entry per
  // completed step, and every loss and gradient norm must be finite.
  const stepMetrics = raw.stepMetrics;
  if (!Array.isArray(stepMetrics) || stepMetrics.length !== stepsCompleted) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `raw result must carry one stepMetrics entry per completed step (${stepsCompleted}), got ${Array.isArray(stepMetrics) ? stepMetrics.length : typeof stepMetrics}`,
      { fieldPaths: ['stepMetrics'] }
    );
  }
  for (const [i, entry] of stepMetrics.entries()) {
    const e = entry as Record<string, unknown>;
    if (!isFiniteNumber(e.loss)) {
      throw new ExperimentError('INVALID_RESULT', `stepMetrics[${i}].loss is not finite: ${String(e.loss)}`, {
        fieldPaths: [`stepMetrics[${i}].loss`],
      });
    }
    if (!isFiniteNumber(e.maxGradNorm)) {
      throw new ExperimentError('INVALID_RESULT', `stepMetrics[${i}].maxGradNorm is not finite: ${String(e.maxGradNorm)}`, {
        fieldPaths: [`stepMetrics[${i}].maxGradNorm`],
      });
    }
  }

  // Logits: only asserted when the runner reports them. Absence is a recorded gap, not a pass.
  let logitsChecked = false;
  const finalLogits = raw.finalLogits;
  if (finalLogits !== undefined) {
    if (!Array.isArray(finalLogits) || finalLogits.length !== batchSize) {
      throw new ExperimentError(
        'INVALID_RESULT',
        `raw result must carry ${batchSize} logits rows (batchSize from the manifest), got ${Array.isArray(finalLogits) ? finalLogits.length : typeof finalLogits}`,
        { fieldPaths: ['finalLogits'] }
      );
    }
    for (const [r, row] of finalLogits.entries()) {
      if (!Array.isArray(row) || row.length !== dataSpec.numClasses) {
        throw new ExperimentError(
          'INVALID_RESULT',
          `logits row ${r} must have ${dataSpec.numClasses} entries (numClasses from the manifest)`,
          { fieldPaths: [`finalLogits[${r}]`] }
        );
      }
      for (const [c, value] of row.entries()) {
        if (!isFiniteNumber(value)) {
          throw new ExperimentError('INVALID_RESULT', `non-finite logits value at [${r}, ${c}]: ${String(value)}`, {
            fieldPaths: [`finalLogits[${r}][${c}]`],
          });
        }
      }
    }
    logitsChecked = true;
  }
  const declaredGaps: string[] = [];
  if (!logitsChecked) {
    declaredGaps.push(
      'logits values were not host-checked: the pinned runner does not report finalLogits. The forward pass is still checked indirectly (a non-finite logits or loss raises inside the runner, and the run then exits non-zero).'
    );
  }
  if (outputSchema.shape[1] !== resolved.entry.runtime.slotChannels) {
    declaredGaps.push('the slot channel count and the runtime pin disagree; this should have been refused at load time.');
  }

  if (!isFiniteNumber(raw.initialLoss) || !isFiniteNumber(raw.finalLoss)) {
    throw new ExperimentError('INVALID_RESULT', 'initialLoss and finalLoss must both be finite numbers', {
      fieldPaths: ['finalLoss'],
    });
  }
  const gradientCheck = raw.gradientCheck as { finite?: unknown; anyNonZero?: unknown } | undefined;
  if (gradientCheck?.finite !== true) {
    throw new ExperimentError('INVALID_RESULT', 'backward gradient check failed: non-finite gradients detected', {
      fieldPaths: ['gradientCheck.finite'],
    });
  }
  if (gradientCheck?.anyNonZero !== true) {
    throw new ExperimentError('INVALID_RESULT', 'backward gradient check failed: all gradients are zero', {
      fieldPaths: ['gradientCheck.anyNonZero'],
    });
  }
  if (raw.parameterUpdated !== true) {
    throw new ExperimentError('INVALID_RESULT', 'no baseline parameter was updated over the declared steps', {
      fieldPaths: ['parameterUpdated'],
    });
  }

  // ---- (f) Environment: the device and versions the pin promised must be what ran. ----
  const observedEnv = (raw.environment ?? {}) as Record<string, unknown>;
  if (observedEnv.device !== resolved.environment.device) {
    throw new ExperimentError(
      'PREFLIGHT_FAILED',
      `run reported device "${String(observedEnv.device)}" but the environment pin declares "${resolved.environment.device}"`,
      { fieldPaths: ['environment.device'] }
    );
  }
  if (observedEnv.pythonVersion !== resolved.environment.interpreter.version) {
    throw new ExperimentError(
      'PREFLIGHT_FAILED',
      `run reported pythonVersion "${String(observedEnv.pythonVersion)}" but the environment pin declares "${resolved.environment.interpreter.version}"`,
      { fieldPaths: ['environment.pythonVersion'] }
    );
  }
  if (observedEnv.torchVersion !== resolved.environment.packages.torch) {
    throw new ExperimentError(
      'PREFLIGHT_FAILED',
      `run reported torchVersion "${String(observedEnv.torchVersion)}" but the environment pin declares "${resolved.environment.packages.torch}"`,
      { fieldPaths: ['environment.torchVersion'] }
    );
  }

  // ---- (g) Per-module mechanism facts. This is what feeds the check engine. ----
  const modulesExecuted = (raw.modulesExecuted ?? {}) as Record<string, Record<string, unknown>>;
  const recipe = prepared.manifest.recipe as CompiledRecipe;
  const modules: ModuleVerdict[] = [];

  for (const module of recipe.modules) {
    const observed = modulesExecuted[module.id];
    if (!observed) {
      // The recipe named it, the run did not report it: attached-but-never-executed.
      modules.push({
        moduleId: module.id,
        position: module.position,
        mechanismKind: module.mechanismKind,
        executionCount: 0,
        maxGradNorm: 0,
        parameterUpdated: false,
        parameterCount: 0,
        isParameterFree: module.mechanismKind === 'parameter_free_operator',
        checkKind:
          module.mechanismKind === 'parameter_free_operator' ? 'parameter_free_operator' : 'parameterized_feature',
        status: 'failed',
        reason: 'the compiled recipe names this module but the run reported no execution record for it',
      });
      continue;
    }

    const executionCount = isFiniteNumber(observed.executionCount) ? observed.executionCount : 0;
    const maxGradNorm = isFiniteNumber(observed.maxGradNorm) ? observed.maxGradNorm : 0;
    const parameterCount = isFiniteNumber(observed.parameterCount) ? observed.parameterCount : 0;
    const isParameterFree = observed.isParameterFree === true || parameterCount === 0;
    const checkKind: ModuleVerdict['checkKind'] = isParameterFree
      ? 'parameter_free_operator'
      : 'parameterized_feature';

    let status: ModuleVerdict['status'] = 'passed';
    let reason = '';

    if (executionCount < 1) {
      status = 'failed';
      reason = `module was attached but executionCount == 0 across the declared steps (expected >= 1 per forward pass)`;
    } else if (isParameterFree) {
      // SPEC section 4: a parameter-free module must NOT be required to update a parameter.
      status = 'passed';
      reason = `parameter-free module executed ${executionCount} time(s); no parameter-update requirement applies (parameterCount=0)`;
    } else if (!(observed.parameterUpdated === true)) {
      status = 'failed';
      reason = `trainable parameters did not change over the declared steps (parameterCount=${parameterCount})`;
    } else if (!(maxGradNorm > 0)) {
      status = 'failed';
      reason = `parameterized module reported maxGradNorm=${maxGradNorm}; an all-zero gradient means the optimizer never saw it`;
    } else {
      reason = `executed ${executionCount} time(s), maxGradNorm=${maxGradNorm}, parameterUpdated=true (parameterCount=${parameterCount})`;
    }

    modules.push({
      moduleId: module.id,
      position: module.position,
      mechanismKind: module.mechanismKind,
      executionCount,
      maxGradNorm,
      parameterUpdated: observed.parameterUpdated === true,
      parameterCount,
      isParameterFree,
      checkKind,
      status,
      reason,
    });
  }

  // The observed order must equal the declared order.
  const observedOrder = modules.map((m) => m.moduleId);
  const declaredOrder = recipe.modules.map((m) => m.id);
  if (JSON.stringify(observedOrder) !== JSON.stringify(declaredOrder)) {
    throw new ExperimentError('INVALID_RESULT', 'observed module order does not match the declared order', {
      fieldPaths: ['modules'],
    });
  }

  // A required module failure is a failed run, not a warning.
  const failedModules = modules.filter((m) => m.status === 'failed');
  if (failedModules.length > 0) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `module mechanism check failed: ${failedModules.map((m) => `${m.moduleId} (${m.reason})`).join('; ')}`,
      { fieldPaths: failedModules.map((m) => `modules.${m.moduleId}`) }
    );
  }

  const metrics = (raw.metrics ?? {}) as Record<string, { value: number; unit: string; split: string; sampleCount: number }>;

  return {
    schemaVersion: 1,
    runId: prepared.runId,
    variant: prepared.variant,
    stage: prepared.stage,
    seed: prepared.seed,
    profileRef: `${resolved.profile.id}@${resolved.profile.version}`,
    manifestHash: prepared.manifestHash,
    rawResultFileSha256: observedRawHash,
    status: 'verified',
    stepsCompleted,
    sampleCount: raw.sampleCount as number,
    batchSize: raw.batchSize as number,
    initialLoss: raw.initialLoss,
    finalLoss: raw.finalLoss,
    metrics,
    modules,
    environmentObserved: observedEnv,
    wallTimeMs: isFiniteNumber(raw.wallTimeMs) ? raw.wallTimeMs : -1,
    declaredGaps,
    verifiedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Registered ref implementations
// ---------------------------------------------------------------------------

/** `runner:phase2-cpu-seg-v1` — starts the pinned runner with the host-built argv. */
export async function runPhase2CpuSegRunner(
  resolved: ResolvedTaskProfile,
  prepared: PreparedRun,
  manifestPath: string,
  abortSignal?: AbortSignal,
  resourceLimits?: { maxWorkingSetBytes: number; maxOutputBytes: number; sampleIntervalMs?: number }
): Promise<RunFacts> {
  assertIsolationOrThrow(resolved.isolation, manifestPath, 'write');
  assertIsolationOrThrow(resolved.isolation, prepared.outputDir, 'write');
  if (resourceLimits) {
    validateRunResourceLimits(resourceLimits);
    await assertResourceMonitorAvailable();
  }

  const stdoutPath = path.join(prepared.outputDir, 'stdout.log');
  const stderrPath = path.join(prepared.outputDir, 'stderr.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const startedAt = Date.now();
  let timedOut = false;
  let peakWorkingSetBytes = 0;
  let resourceSampleCount = 0;
  let outputBytes = 0;
  let resourceLimitExceeded: string | null = null;
  let pendingSample: Promise<void> | null = null;

  const exitInfo = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    // argv[0] is the interpreter, argv[1] the pinned script: both from the registry.
    const child = spawn(prepared.argv[0], prepared.argv.slice(1), {
      cwd: prepared.cwd,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    });
    let settled = false;
    const killChild = (): void => {
      try {
        if (child.pid) process.kill(child.pid);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process; a timed-out run must not keep training in the background.
      killChild();
    }, prepared.timeoutMs);
    let monitorTimer: NodeJS.Timeout | null = null;
    const sampleResources = async (): Promise<void> => {
      if (!resourceLimits || settled || pendingSample) return;
      pendingSample = (async () => {
        try {
          if (child.pid === undefined) throw new Error('runner process has no pid for resource monitoring');
          const sample = await queryWorkingSetBytes(child.pid);
          if (sample !== null) {
            peakWorkingSetBytes = Math.max(peakWorkingSetBytes, sample);
            resourceSampleCount += 1;
            if (sample > resourceLimits.maxWorkingSetBytes) {
              resourceLimitExceeded = `working set ${sample} bytes exceeded ${resourceLimits.maxWorkingSetBytes} bytes`;
            }
          }
          outputBytes = directoryBytes(prepared.outputDir);
          if (outputBytes > resourceLimits.maxOutputBytes) {
            resourceLimitExceeded = `run output ${outputBytes} bytes exceeded ${resourceLimits.maxOutputBytes} bytes`;
          }
        } catch (error) {
          resourceLimitExceeded = `resource monitor failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (resourceLimitExceeded) killChild();
      })().finally(() => { pendingSample = null; });
      await pendingSample;
    };
    if (resourceLimits) {
      void sampleResources();
      monitorTimer = setInterval(() => { void sampleResources(); }, resourceLimits.sampleIntervalMs ?? 250);
      monitorTimer.unref();
    }
    // Cooperative cancel: the child is KILLED, not merely marked cancelled.
    // A "cancelled" run whose process keeps training is not a cancellation —
    // that is the failure the SPEC names when it separates stopping the text
    // generation from cancelling the experiment.
    const onAbort = (): void => {
      killChild();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (monitorTimer) clearInterval(monitorTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve({ code, signal });
    };
    child.on('close', (code, signal) => finish(code, signal));
    child.on('error', () => finish(1, null));
  });
  if (pendingSample) await pendingSample;

  try {
    fs.closeSync(stdoutFd);
  } catch {
    /* already closed */
  }
  try {
    fs.closeSync(stderrFd);
  } catch {
    /* already closed */
  }

  const durationMs = Date.now() - startedAt;
  if (resourceLimits) {
    outputBytes = directoryBytes(prepared.outputDir);
    if (resourceSampleCount === 0 && resourceLimitExceeded === null) {
      resourceLimitExceeded = 'resource monitor returned no working-set sample while the runner was live';
    }
    if (outputBytes > resourceLimits.maxOutputBytes) {
      resourceLimitExceeded = `run output ${outputBytes} bytes exceeded ${resourceLimits.maxOutputBytes} bytes`;
    }
  }
  const readTail = (p: string): string => {
    if (!fs.existsSync(p)) return '';
    const text = fs.readFileSync(p, 'utf8');
    return text.length <= 4000 ? text : `...${text.slice(text.length - 4000)}`;
  };
  const rawResultPath = path.join(prepared.outputDir, 'raw-result.json');

  return {
    runId: prepared.runId,
    manifestHash: prepared.manifestHash,
    exitCode: exitInfo.code ?? (timedOut ? 124 : 1),
    signal: exitInfo.signal,
    timedOut,
    durationMs,
    stdoutTail: readTail(stdoutPath),
    stderrTail: readTail(stderrPath),
    rawResultPath: fs.existsSync(rawResultPath) ? rawResultPath : null,
    completedAt: new Date().toISOString(),
    ...(resourceLimits ? {
      peakWorkingSetBytes,
      outputBytes,
      resourceSampleCount,
      resourceLimitExceeded,
    } : {}),
  };
}

function validateRunResourceLimits(value: { maxWorkingSetBytes: number; maxOutputBytes: number; sampleIntervalMs?: number }): void {
  for (const [field, number] of Object.entries(value)) {
    if (number === undefined) continue;
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new ExperimentError('CONFIG_INCOMPLETE', `resource limit ${field} must be a positive safe integer`);
    }
  }
}

export async function assertResourceMonitorAvailable(): Promise<void> {
  if (process.platform === 'win32') {
    const windowsRoot = process.env.WINDIR ?? 'C:\\Windows';
    const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!fs.existsSync(powershell)) throw new ExperimentError('CONFIG_INCOMPLETE', `Windows resource monitor is unavailable: ${powershell}`);
    const sample = await queryWorkingSetBytes(process.pid, powershell);
    if (sample === null || sample <= 0) throw new ExperimentError('CONFIG_INCOMPLETE', 'Windows resource monitor returned no working-set sample for the host process');
    return;
  }
  if (process.platform === 'linux') {
    if (!fs.existsSync('/proc/self/status')) throw new ExperimentError('CONFIG_INCOMPLETE', 'Linux /proc resource monitor is unavailable');
    return;
  }
  throw new ExperimentError('CONFIG_INCOMPLETE', `no host resource monitor is implemented for ${process.platform}`);
}

export function queryWorkingSetBytes(pid: number, powershellOverride?: string): Promise<number | null> {
  if (process.platform === 'linux') {
    const statusPath = `/proc/${pid}/status`;
    if (!fs.existsSync(statusPath)) return Promise.resolve(null);
    const text = fs.readFileSync(statusPath, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
    if (!match) throw new Error(`VmRSS is absent for process ${pid}`);
    return Promise.resolve(Number(match[1]) * 1024);
  }
  if (process.platform !== 'win32') return Promise.reject(new Error(`resource sampling is unsupported on ${process.platform}`));
  const windowsRoot = process.env.WINDIR ?? 'C:\\Windows';
  const powershell = powershellOverride ?? path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.Write([int64]$p.WorkingSet64) }`;
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 3000 }, (error, stdout, stderr) => {
      if (error) {
        let processGone = false;
        try { process.kill(pid, 0); } catch (probeError) {
          processGone = (probeError as NodeJS.ErrnoException).code === 'ESRCH';
        }
        if (processGone && stdout.trim().length === 0 && stderr.trim().length === 0) { resolve(null); return; }
        reject(new Error(`PowerShell process sample failed: ${error.message}; ${stderr.trim()}`));
        return;
      }
      const output = stdout.trim();
      if (!output) { resolve(null); return; }
      if (!/^\d+$/.test(output)) { reject(new Error(`PowerShell returned a malformed working-set sample: ${output}`)); return; }
      resolve(Number(output));
    });
  });
}

export function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  const pending = [root];
  let total = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of fs.readdirSync(current)) {
      const absolute = path.join(current, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) pending.push(absolute);
      else total += stat.size;
    }
  }
  return total;
}

/** `compiler:phase2-cpu-seg-v1` — the registered compiler symbol. */
export function compilePhase2CpuSegRecipe(
  resolved: ResolvedTaskProfile,
  implementation: ImplementationRef,
  bindings: readonly PlanBindingLike[],
  variant: string
): CompiledRecipe {
  return compileRecipe(resolved, implementation, bindings, variant);
}

/** `verifier:phase2-cpu-seg-v1` — the registered verifier symbol. */
export function verifyPhase2CpuSegRun(
  resolved: ResolvedTaskProfile,
  prepared: PreparedRun,
  facts: RunFacts,
  artifacts: RunArtifacts
): VerifiedRun {
  return verifyRun(resolved, prepared, facts, artifacts);
}

/**
 * Collects the artifact hashes `verifyRun` needs, from disk, for one prepared run.
 * Kept separate so the verifier stays a pure function of (manifest, facts, artifacts).
 */
export function collectRunArtifacts(prepared: PreparedRun, manifestPath: string): RunArtifacts {
  const moduleFileSha256: Record<string, string> = {};
  for (const module of (prepared.manifest.recipe as CompiledRecipe).modules) {
    if (fs.existsSync(module.implementationPath)) {
      moduleFileSha256[module.id] = sha256File(module.implementationPath);
    }
  }
  const rawResultPath = path.join(prepared.outputDir, 'raw-result.json');
  return {
    manifestFileSha256: sha256File(manifestPath),
    rawResultFileSha256: fs.existsSync(rawResultPath) ? sha256File(rawResultPath) : '0'.repeat(64),
    moduleFileSha256,
  };
}
