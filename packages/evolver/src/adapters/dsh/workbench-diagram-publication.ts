/**
 * Diagram publication: the restricted, task-scoped artifact registrar (W7).
 *
 * Spec: docs/mvp/WORKBENCH-RESEARCH-SPEC.md section 8.2.
 *
 * What this is, and what it deliberately is not
 * ----------------------------------------------
 * It registers ONE file — a diagram the host asked a diagram Skill to produce —
 * from a fixed scratch workspace into the workbench sidecar. It is NOT a general
 * file upload endpoint, and it is designed so that it cannot become one:
 *
 *  - the scratch directory is computed by the Host from `taskId` +
 *    `semanticHash` + `format`. The caller cannot name a path;
 *  - the file must be inside that directory after `realpath` resolution, so
 *    `..`, a junction and a symlink cannot step outside it;
 *  - only a fixed FILENAME per format is accepted;
 *  - size and format are checked before the copy;
 *  - registration NEVER advances `designRevision`. Only `attach_diagram` does.
 *    A diagram can be re-registered against an unchanged design; it is a
 *    separate act from committing it to the task.
 *
 * Why the semantic hash matters here
 * ---------------------------------
 * The registrar recomputes the semantic hash of the graph the diagram claims to
 * represent and compares it with the CURRENT one. That single check is what
 * stops a diagram made for an older structure from being presented as current,
 * and it is why `stale` is a derived state rather than a stored flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  WorkbenchContractError,
  type BoundRef,
  type WorkbenchBoundRef,
  type AnyDiagramDraft,
  type DiagramDraft,
  type DiagramDraftV2,
  type DiagramFormat,
  type DiagramStatus,
  type StrictArtifactRef,
  validateRegisterDiagramV2,
  DIAGRAM_FORMATS,
} from '../../contracts/workbench.ts';
import { deriveDiagramStatus, SEMANTIC_HASH_ALGORITHM_V2 } from '../../domain/model-dataflow.ts';
import {
  PublicationCoordinator,
  artifactSetHash,
  canonicalCommandKey,
  canonicalRequestHash,
  coordinatorFor,
  type CommittedPublication,
  type PublicationArtifactIdentity,
  type PublicationCommandIntent,
} from '../../application/workbench-publication-coordinator.ts';

/**
 * The registrar's input: the strict RegisterDiagramV2 request plus the values
 * ONLY the Host can compute.
 *
 * SPEC section R3.4: the registrar never fills `expectedDesignRevision` in from
 * the current task. A registrar that reads the revision itself and then compares
 * it to itself always passes, which is not a compare-and-swap. The caller states
 * the revision it believes is current; the task-lock holder checks it against the
 * task; the registrar records the stated value in the durable intent.
 */
export interface RegisterDiagramInput {
  /** Required and explicit; a request without it is refused, not defaulted. */
  schemaVersion: 2;
  outputKey: 'main';
  taskId: string;
  commandId: string;
  ownerSessionId: string;
  /** The revision the CALLER believes is current. Never auto-filled here. */
  expectedDesignRevision: number;
  candidateKey?: string;
  variantKey?: string | null;
  /** The graph the diagram claims to represent, as the Host computed it. */
  semanticGraphRef: WorkbenchBoundRef;
  /** The CURRENT semantic hash, recomputed by the Host. */
  semanticHash: string;
  format: DiagramFormat;
  /**
   * The node / edge ids the CURRENT structure contains.
   *
   * Supplied by the Host, never by the model: a diagram must be checked against
   * the structure it claims to depict, and only the Host knows that structure.
   * An empty list means "no structure was supplied", which SKIPS the check
   * rather than passing it — an empty expectation must never be read as
   * "everything matched".
   */
  expectedNodeIds?: string[];
  expectedEdgeIds?: string[];
  expectedNodeLabels?: Record<string, string>;
  expectedEdgeEndpoints?: Record<string, { source: string; sourcePort: string; target: string; targetPort: string; relation?: 'tensor' | 'supervision' | 'control' }>;
}

export interface RegisterDiagramOutput {
  receipt: {
    operationId: string;
    commandId: string;
    requestHash: string;
    taskId: string;
    resultRefs: BoundRef[];
    reused: boolean;
  };
  diagramDraftRef: BoundRef;
}

/**
 * The one filename accepted per format.
 *
 * A fixed name (rather than "whatever the caller says") means the registrar
 * never joins caller text into a path. `outputKey` in the SPEC narrows this to
 * `main`; the sidecars the diagram Skills emit are recorded by the Skill itself.
 */
const EXPECTED_FILE: Record<DiagramFormat, string> = {
  archify_html: 'diagram.html',
  excalidraw: 'diagram.excalidraw',
};

/** A generous but real ceiling; a diagram artifact is not a dataset. */
export const MAX_DIAGRAM_BYTES = 32 * 1024 * 1024;

export interface DiagramScratchConfig {
  /** Where per-task scratch workspaces live (repo-relative). */
  scratchRoot: string;
  /** Where published diagrams go. This IS `R/published`. */
  publishedRoot: string;
  /**
   * The sidecar store root `R`. Defaults to the parent of `publishedRoot`, which
   * is what the ref contract already requires, so the single-commit-index and
   * write-lease paths cannot be pointed at a different store by accident.
   */
  storeRoot?: string;
}

/** Sidecars are small metadata files; the ceiling keeps a stray blob out. */
export const MAX_SIDECAR_BYTES = 1024 * 1024;

/**
 * The fixed scratch workspace for one (task, semanticHash, format).
 *
 * The semantic hash is part of the directory name on purpose: a diagram drawn
 * for an older structure lands in a DIFFERENT directory and therefore cannot be
 * picked up as if it described the current one.
 *
 * `taskId` is caller-influenced, so it is reduced to a single path SEGMENT
 * before it is joined. `path.join` alone would happily honour `..`, a drive
 * letter or a UNC prefix, letting a task id name a directory outside the
 * scratch root; here that simply resolves to an absent workspace, which the
 * registrar then refuses with DEPENDENCY_NOT_READY.
 */
export function scratchDirFor(config: DiagramScratchConfig, input: { taskId: string; semanticHash: string; format: DiagramFormat }): string {
  return path.join(config.scratchRoot, safeSegment(input.taskId), `${safeSegment(input.semanticHash).slice(0, 24)}-${safeSegment(input.format)}`);
}

/**
 * One path segment derived from untrusted text.
 *
 * Everything outside `[A-Za-z0-9._-]` becomes `_`, and a leading dot is
 * neutralised, so the result can be neither a traversal, an absolute path, a
 * drive/UNC prefix, nor a hidden file. Two different inputs may collide onto
 * the same segment; that is safe because the caller still has to pass the Host
 * semantic hash, which is content-addressed.
 */
function safeSegment(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = cleaned.replace(/^\.+/, '_');
  return trimmed.length === 0 ? '_' : trimmed.slice(0, 128);
}

/** What the Host hands the diagram Skill as its working directory. */
export function scratchWorkspaceFor(config: DiagramScratchConfig, input: { taskId: string; semanticHash: string; format: DiagramFormat }): {
  dir: string;
  expectedFile: string;
} {
  return { dir: scratchDirFor(config, input), expectedFile: EXPECTED_FILE[input.format] };
}

export class DiagramPublisher {
  private readonly config: DiagramScratchConfig;
  private readonly indexPath: string;
  /** The ONE durable commit point this registrar shares with the service. */
  private readonly coordinator: PublicationCoordinator;
  /** Set when the published root could not even be created; refused at register. */
  private unusableRoot: string | null = null;

  constructor(config: DiagramScratchConfig) {
    this.config = config;
    // `R` is derived from `publishedRoot` unless a caller states it, so the
    // commit index and the write lease always sit beside the published root
    // rather than in a second, possibly different, store.
    this.coordinator = coordinatorFor(config.storeRoot ?? path.resolve(config.publishedRoot, '..'));
    this.indexPath = path.join(config.publishedRoot, 'diagrams.json');
    try {
      fs.mkdirSync(config.publishedRoot, { recursive: true });
      fs.mkdirSync(path.join(config.publishedRoot, 'diagrams'), { recursive: true });
    } catch (err) {
      // A registrar whose output root cannot be created must say so with a
      // workbench error, not leak a raw EEXIST/EACCES to its caller. The failure
      // becomes observable at the first register, where the code is precise.
      this.unusableRoot = `cannot create the published root ${config.publishedRoot}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * The coordinator whose root commit index is the single visible commit point.
   * Exposed so the service and the tests resolve the SAME index, instead of each
   * re-deriving a path and drifting by one directory the way the published root
   * did before R1.
   */
  get publicationCoordinator(): PublicationCoordinator {
    return this.coordinator;
  }

  /**
   * The ONE root every workbench ref resolves under: `R/published`.
   *
   * Round-2 defect: the registrar used to publish into `R` while the service
   * resolver and the projection resolved workbench refs under `R/published`, so
   * a draft the registrar had just committed was one directory too shallow for
   * every other reader. The root is exposed so fixtures assert the SAME root
   * the production resolvers use, instead of hard-coding it a fourth time.
   */
  get publishedRoot(): string {
    return path.resolve(this.config.publishedRoot);
  }

  /** The legacy registrar index; a rebuildable cache, never the commit point. */
  get cacheIndexPath(): string {
    return this.indexPath;
  }

  /**
   * Where a diagram of a given structure must be written.
   *
   * Exposed because `evolver_get_stage_context` has to tell the agent this path.
   * Deriving it by climbing out of the publisher's own private index file would
   * couple the context to that file's location, and a second copy of the
   * convention here is exactly the kind of drift the Host owns.
   */
  workspaceFor(taskId: string, semanticHash: string, format: DiagramFormat): { dir: string; expectedFile: string } {
    return scratchWorkspaceFor(this.config, { taskId, semanticHash, format });
  }

  /**
   * Register the main output of one diagram run.
   *
   * The Host computes `semanticHash` from the graph it is actually serving and
   * passes it in. A model cannot supply its own hash, so it cannot claim a
   * diagram matches a graph it never saw.
   */
  register(input: RegisterDiagramInput): RegisterDiagramOutput {
    const key = canonicalCommandKey({ ownerSessionId: input.ownerSessionId, action: 'register_diagram_output', commandId: input.commandId });
    return this.coordinator.runCommand(key, () => this.withIndexLock(() => this.registerUnderIndexLock(input)));
  }

  /**
   * Replay a command that is ALREADY committed, or refuse.
   *
   * SPEC section R2.3 / R4: a committed command is answered from the commit
   * index. It is never re-executed, so a later revision change or a modified
   * scratch directory cannot turn one committed command into a second operation.
   */
  private replayCommitted(
    committed: { operationId: string; requestBaseHash: string; requestHash: string; receipt: Record<string, unknown>; artifactSet: PublicationArtifactIdentity[]; diagramDraftRef?: BoundRef },
    requestBaseHash: string,
    commandId: string,
  ): RegisterDiagramOutput {
    if (committed.requestBaseHash !== requestBaseHash) {
      throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `commandId ${JSON.stringify(commandId)} was replayed with different graph or request inputs`, { fieldPaths: ['commandId'] });
    }
    // A replay must not hand back a receipt whose published bytes have since been
    // damaged. SPEC section 7: an index pointing at a missing or corrupt object is
    // ARTIFACT_CORRUPT, never a quiet reuse. Every member of the recorded set is
    // checked, including the ones that were legitimately ABSENT at commit time --
    // those must still be absent, or the object was substituted afterwards.
    for (const artifact of committed.artifactSet) {
      const bytes = this.readPublishedBytes({ store: 'workbench', ref: { id: artifact.id, sha256: artifact.sha256 } });
      if (artifact.present && bytes === null) {
        throw new WorkbenchContractError('ARTIFACT_CORRUPT', `operation ${committed.operationId} is committed but artifact ${artifact.id} is missing or no longer matches its hash; a replay cannot reuse it`, { retryable: false, fieldPaths: ['commandId'] });
      }
      if (!artifact.present && bytes !== null) {
        throw new WorkbenchContractError('ARTIFACT_CORRUPT', `operation ${committed.operationId} recorded ${artifact.id} as absent but an object now exists there; refusing to treat it as the committed result`, { retryable: false, fieldPaths: ['commandId'] });
      }
    }
    const draftRef = committed.diagramDraftRef;
    if (draftRef === undefined || this.readPublishedBytes(draftRef) === null) {
      throw new WorkbenchContractError('ARTIFACT_CORRUPT', `operation ${committed.operationId} is committed but its diagram draft is missing or no longer matches its hash; a replay cannot reuse it`, { retryable: false, fieldPaths: ['commandId'] });
    }
    return { receipt: { ...(committed.receipt as unknown as RegisterDiagramOutput['receipt']), reused: true }, diagramDraftRef: draftRef };
  }

  private registerUnderIndexLock(input: RegisterDiagramInput): RegisterDiagramOutput {
    if (this.unusableRoot !== null) {
      throw new WorkbenchContractError('UNSUPPORTED_CAPABILITY', `the published root is not writable in this Host: ${this.unusableRoot}`, { retryable: false, fieldPaths: ['publishedRoot'] });
    }
    // SPEC section R3.1: the registrar validates the request itself, so a direct
    // execute and the tool's schema wrapper refuse the SAME shapes with the SAME
    // code. Relying on the wrapper alone would leave the registrar accepting a
    // request the tool never promised to send.
    const validated = validateRegisterDiagramV2(input, { allowHostFields: true });
    if (!validated.ok) {
      throw new WorkbenchContractError(validated.code, validated.message, { fieldPaths: validated.fieldPaths });
    }
    if (!Number.isInteger(input.expectedDesignRevision) || input.expectedDesignRevision < 1) {
      throw new WorkbenchContractError('INVALID_INPUT', 'expectedDesignRevision must be an integer >= 1', { fieldPaths: ['expectedDesignRevision'] });
    }
    if (!/^[0-9a-f]{64}$/.test(input.semanticHash)) {
      throw new WorkbenchContractError('INVALID_INPUT', 'semanticHash must be a sha256 hex digest computed by the Host', { fieldPaths: ['semanticHash'] });
    }

    const requestBase = {
      taskId: input.taskId,
      candidateKey: input.candidateKey ?? '',
      variantKey: input.variantKey ?? null,
      expectedDesignRevision: input.expectedDesignRevision,
      semanticGraphRef: input.semanticGraphRef,
      semanticHash: input.semanticHash,
      format: input.format,
    };
    const requestBaseHash = canonicalRequestHash(requestBase);
    // SPEC R2.3: the request hash covers ONLY the canonical request identity. The
    // output bytes are deliberately excluded -- they are the artifact set's job.
    // Including them here is what made a retry compare against whatever the
    // scratch directory held at retry time instead of what was frozen.
    const requestHash = requestBaseHash;
    const operationId = `wdg-${input.format}-${createHash('sha256').update(`${input.ownerSessionId}::${input.commandId}`).digest('hex').slice(0, 16)}`;
    const scratch = scratchDirFor(this.config, input);
    const expected = EXPECTED_FILE[input.format];
    const source = path.join(scratch, expected);

    const key = canonicalCommandKey({ ownerSessionId: input.ownerSessionId, action: 'register_diagram_output', commandId: input.commandId });

    // (1) The COMMITTED path first: a command that already succeeded is answered
    // from the single commit index and is never re-executed (SPEC R2.3/R4).
    const committed = this.coordinator.readCommitIndex().publications[key];
    if (committed !== undefined) {
      return this.replayCommitted(committed, requestBaseHash, input.commandId);
    }

    // (2) A PREPARED or FROZEN intent is a command that started and did not
    // commit. It is NOT re-executed against whatever the scratch holds now; the
    // recorded pins are reused and the frozen bytes decide.
    const intent = this.coordinator.readIntent(key);
    if (intent !== null) {
      if (intent.requestBaseHash !== requestBaseHash) {
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `commandId ${JSON.stringify(input.commandId)} was replayed with different graph or request inputs`, { fieldPaths: ['commandId'] });
      }
      const frozen = intent.artifactSet;
      if (frozen !== undefined) {
        // Compare the scratch main/mapping/receipt against the frozen identity.
        // The draft is not a scratch input, so it is verified in the commit set.
        const current = this.fingerprintScratch(scratch, expected, operationId);
        // Compare only the SCRATCH-DERIVED inputs (main, mapping, receipt). The
        // draft is not a scratch input, so the frozen set is reduced to the same
        // subset before comparing -- otherwise the comparison would be vacuous
        // and every retry would conflict regardless of the bytes.
        const inputSubset = frozen.filter((a) =>
          a.id.endsWith(`/${expected}`)
          || a.id.endsWith('/semantic-mapping.json')
          || a.id.endsWith('/validation-receipt.json'));
        if (artifactSetHash(current) !== artifactSetHash(inputSubset)) {
          throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `commandId ${JSON.stringify(input.commandId)} was frozen with different output bytes; the frozen result is preserved`, { fieldPaths: ['commandId'] });
        }
        // SPEC section R5: recovery resumes the ORIGINAL frozen set. The scratch
        // bytes still match what was frozen and the frozen objects themselves are
        // intact on disk, so the commit that was interrupted can be completed
        // exactly once, from exactly those bytes -- never from a re-read of the
        // scratch as it happens to be now.
        const missing = frozen.filter((a) => a.present
          && this.readPublishedBytes({ store: 'workbench', ref: { id: a.id, sha256: a.sha256 } }) === null);
        if (missing.length > 0) {
          throw new WorkbenchContractError('ARTIFACT_CORRUPT', `operation ${intent.operationId} froze ${missing.map((m) => m.id).join(', ')} but those objects are gone; recovery cannot proceed from a partial freeze`, { retryable: false, fieldPaths: ['commandId'] });
        }
        return this.commitFrozenIntent(intent, input, expected, operationId, requestBaseHash, requestHash, frozen);
      }
      if (intent.operationId !== operationId) {
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `commandId ${JSON.stringify(input.commandId)} already allocated operation ${intent.operationId}`, { fieldPaths: ['commandId'] });
      }
    } else {
      // (3) FIRST attempt: persist the intent BEFORE any object is written, so a
      // crash cannot leave frozen bytes with no record of which command made them.
      this.coordinator.writeIntent({
        schemaVersion: 2,
        key,
        ownerSessionId: input.ownerSessionId,
        action: 'register_diagram_output',
        commandId: input.commandId,
        taskId: input.taskId,
        operationId,
        requestBaseHash,
        requestHash,
        expectedDesignRevision: input.expectedDesignRevision,
        candidateKey: input.candidateKey ?? '',
        variantKey: input.variantKey ?? null,
        semanticGraphRef: input.semanticGraphRef,
        semanticHash: input.semanticHash,
        format: input.format,
        createdAt: new Date().toISOString(),
        state: 'prepared',
      });
    }

    // (3) A FIRST attempt, or a retry of a not-yet-frozen intent: if the main
    // source file is absent the fixed-name artifact hasn't been produced yet, so
    // the staged intent remains prepared and a later attempt may use the first
    // actual output. Once the set is frozen (above), scratch can no longer replace
    // it.
    if (!fs.existsSync(scratch)) {
      throw new WorkbenchContractError(
        'DEPENDENCY_NOT_READY',
        `绘图工作区尚不存在：${path.relative(process.cwd(), scratch)}。请先用 evolver_get_stage_context 取得该工作区，再让绘图 Skill 输出 ${expected}`,
        { fieldPaths: ['format'] },
      );
    }
    if (!fs.existsSync(source)) {
      throw new WorkbenchContractError(
        'DEPENDENCY_NOT_READY',
        `绘图 Skill 未在固定文件名下产出：期望 ${expected}，实际目录内容 ${describeDir(scratch)}`,
        { fieldPaths: ['format'] },
      );
    }

    // realpath containment, in TWO steps. Step 1: the RESOLVED workspace must
    // still sit inside the RESOLVED scratch root, and no component from the root
    // down may be a reparse point -- a junction ON the workspace directory keeps
    // its own path under realpath on Windows, so only the lstat walk sees it.
    // Step 2 (inside readControlledFile): the resolved file must sit inside that
    // same resolved workspace.
    const realRoot = safeRealpath(scratch);
    const configuredRoot = safeRealpath(this.config.scratchRoot);
    if (realRoot === null || configuredRoot === null || !isInside(configuredRoot, realRoot)) {
      throw new WorkbenchContractError('POLICY_DENIED', '绘图工作区解析后位于 scratch 根之外，拒绝登记', { fieldPaths: ['format'] });
    }
    assertNoReparseComponents(this.config.scratchRoot, scratch, '绘图工作区');
    const realFile = safeRealpath(source);
    if (realFile === null || !isInside(realRoot, realFile)) {
      throw new WorkbenchContractError('POLICY_DENIED', '绘图产物解析后位于指定工作区之外，拒绝登记', { fieldPaths: ['format'] });
    }

    const sourceBytes = this.readControlledFile(scratch, source, MAX_DIAGRAM_BYTES, expected);
    assertFormat(sourceBytes, input.format);

    const bytes = sourceBytes;
    const mappingInputPath = path.join(scratch, 'mapping.json');
    const receiptInputPath = path.join(scratch, 'validation-receipt.json');
    const mappingBytes = this.readOptionalControlledFile(scratch, mappingInputPath, 'mapping.json');
    const receiptBytes = this.readOptionalControlledFile(scratch, receiptInputPath, 'validation-receipt.json');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const destDir = path.join(this.config.publishedRoot, 'diagrams', operationId);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, expected);
    this.writeImmutableFile(destFile, bytes, `diagram output ${expected}`);
    const publishedRef: WorkbenchBoundRef = {
      store: 'workbench',
      ref: { id: `diagrams/${operationId}/${expected}`, sha256 },
    };

    // The semantic mapping and the validation receipt are written BY the Skill,
    // next to the main file. They are registered when present and reported as
    // missing when not, because "the Skill said it validated" and "a validation
    // receipt exists" are different claims.
    const mappingRef = this.copyIfPresent(destDir, scratch, 'mapping.json', operationId, 'semantic-mapping.json');
    const receiptRef = this.copyIfPresent(destDir, scratch, 'validation-receipt.json', operationId, 'validation-receipt.json');
    if ((mappingRef?.ref.sha256 ?? null) !== (mappingBytes === null ? null : createHash('sha256').update(mappingBytes).digest('hex'))
      || (receiptRef?.ref.sha256 ?? null) !== (receiptBytes === null ? null : createHash('sha256').update(receiptBytes).digest('hex'))) {
      throw new WorkbenchContractError('SOURCE_MISMATCH', 'mapping or validation receipt changed while registrar was freezing output bytes', { retryable: true, fieldPaths: ['format'] });
    }

    // SPEC section 8.2: the mapping is CHECKED, not merely filed away. A
    // diagram that dropped a known node, reversed a known edge, or renamed a
    // known label is a different structure wearing the old hash, and collecting
    // the file without reading it would let exactly that pass.
    if (mappingRef !== null) {
      const mapping = this.readMapping(mappingRef);
      if (mapping === null) {
        throw new WorkbenchContractError('INVALID_INPUT', 'mapping.json 存在但不是可读 JSON', { fieldPaths: ['format'] });
      }
      const mappingContext = input.expectedNodeLabels === undefined || input.expectedEdgeEndpoints === undefined
        ? undefined
        : {
          semanticGraphRef: input.semanticGraphRef,
          semanticHash: input.semanticHash,
          expectedNodeLabels: input.expectedNodeLabels,
          expectedEdgeEndpoints: input.expectedEdgeEndpoints,
        };
      const defects = verifyMapping(mapping, input.expectedNodeIds ?? [], input.expectedEdgeIds ?? [], mappingContext);
      if (defects.length > 0) {
        throw new WorkbenchContractError(
          'SOURCE_MISMATCH',
          `图稿与语义结构不符：${defects.slice(0, 5).join('；')}${defects.length > 5 ? `（另有 ${defects.length - 5} 项）` : ''}`,
          { fieldPaths: ['format'] },
        );
      }

      // The mapping is an AGENT CLAIM. The Host must parse the actual published
      // bytes with the format adapter and compare, or the mapping would be the
      // sole authority about what the picture contains (SPEC section 6).
      const parsed = input.format === 'archify_html'
        ? parseArchifySvgSemantics(bytes)
        : parseExcalidrawSemantics(bytes);
      const structuralDefects = [
        ...(parsed.semantics === null ? [...parsed.defects, '图稿没有可解析的 graph element/端点，mapping 不可信'] : parsed.defects),
        ...(parsed.semantics === null ? [] : compareParsedDiagramToMapping(parsed.semantics, mapping)),
      ];
      if (structuralDefects.length > 0) {
        throw new WorkbenchContractError(
          'SOURCE_MISMATCH',
          `图稿实际图元与 mapping 不符：${structuralDefects.slice(0, 5).join('；')}${structuralDefects.length > 5 ? `（另有 ${structuralDefects.length - 5} 项）` : ''}`,
          { fieldPaths: ['format'] },
        );
      }
    }

    // SPEC section R3.5/R3.6: the COMPLETE draft v2 is frozen in one write. It
    // carries its own task/owner/origin identity and an explicit algorithm, so a
    // reader verifies it against its own contents and the commit index instead of
    // trusting whatever JSON happened to sit at the ref. Absent optional evidence
    // is null -- never a synthetic `missing:` ref, which would make "the Skill
    // produced no receipt" indistinguishable from "a receipt exists at a path we
    // invented".
    const draft: DiagramDraftV2 = {
      schemaVersion: 2,
      taskId: input.taskId,
      ownerSessionId: input.ownerSessionId,
      candidateKey: input.candidateKey ?? '',
      variantKey: input.variantKey ?? null,
      originOperationId: operationId,
      graphRef: input.semanticGraphRef,
      semanticHashAlgorithm: SEMANTIC_HASH_ALGORITHM_V2,
      semanticHash: input.semanticHash,
      format: input.format,
      // No Host-observed execution witness exists in this build, so the Skill
      // identity stays null rather than being filled with a plausible string.
      skill: null,
      artifactRefs: [publishedRef],
      semanticMappingRef: mappingRef,
      validationReceiptRef: receiptRef,
      validationWitnessRef: null,
      previewRefs: [],
    };
    const draftRef = this.writeDraft(draft, operationId);

    const receipt = {
      operationId,
      commandId: input.commandId,
      requestHash,
      taskId: input.taskId,
      resultRefs: [publishedRef],
      reused: false,
    };

    // (4) Record the frozen artifact set on the intent BEFORE the index flip.
    // SPEC R2.4: the set covers every frozen object by filename, sha256 and size,
    // with an explicit marker for each optional file that is absent, so a later
    // retry or a recovery can tell "never had a receipt" from "receipt lost".
    const artifactSet: PublicationArtifactIdentity[] = [
      { id: publishedRef.ref.id, sha256: publishedRef.ref.sha256, present: true },
      { id: `diagrams/${operationId}/semantic-mapping.json`, sha256: mappingRef?.ref.sha256 ?? ZERO_HASH, present: mappingRef !== null },
      { id: `diagrams/${operationId}/validation-receipt.json`, sha256: receiptRef?.ref.sha256 ?? ZERO_HASH, present: receiptRef !== null },
      { id: draftRef.ref.id, sha256: draftRef.ref.sha256, present: true },
    ];
    const frozenAt = new Date().toISOString();
    this.coordinator.writeIntent({
      ...(intent ?? {
        schemaVersion: 2 as const,
        key,
        ownerSessionId: input.ownerSessionId,
        action: 'register_diagram_output',
        commandId: input.commandId,
        taskId: input.taskId,
        operationId,
        requestBaseHash,
        requestHash,
        expectedDesignRevision: input.expectedDesignRevision,
        candidateKey: input.candidateKey ?? '',
        variantKey: input.variantKey ?? null,
        semanticGraphRef: input.semanticGraphRef,
        semanticHash: input.semanticHash,
        format: input.format,
        createdAt: frozenAt,
        state: 'prepared',
      }),
      requestHash,
      state: 'frozen',
      artifactSet,
      artifactSetHash: artifactSetHash(artifactSet),
      frozenAt,
    });

    // (5) The ONE commit point. Everything before this rename is invisible to
    // every reader; everything after it is replayable from the index.
    this.coordinator.commitPublication({ ...(intent ?? {
      schemaVersion: 2 as const,
      key,
      ownerSessionId: input.ownerSessionId,
      action: 'register_diagram_output',
      commandId: input.commandId,
      taskId: input.taskId,
      operationId,
      requestBaseHash,
      requestHash,
      expectedDesignRevision: input.expectedDesignRevision,
      candidateKey: input.candidateKey ?? '',
      variantKey: input.variantKey ?? null,
      semanticGraphRef: input.semanticGraphRef,
      semanticHash: input.semanticHash,
      format: input.format,
      createdAt: frozenAt,
      state: 'frozen',
    }) }, {
      receipt: receipt as unknown as Record<string, unknown>,
      artifactSet,
      artifactSetHash: artifactSetHash(artifactSet),
      diagramDraftRef: draftRef,
    });

    // The legacy per-file index is retained ONLY as a rebuildable cache; it is
    // never the commit point, so a failure to update it is recorded rather than
    // allowed to un-commit a result that the root index already published.
    try {
      const cache = this.readIndex();
      cache[key] = { requestBaseHash, requestHash, receipt, diagramDraftRef: draftRef };
      this.writeIndex(cache);
    } catch { /* cache only; the commit index above is authoritative */ }

    return { receipt, diagramDraftRef: draftRef };
  }

  /**
   * Complete the commit of an intent whose artifacts are ALREADY frozen.
   *
   * SPEC section R5: recovery commits the ORIGINAL frozen set, exactly once. It
   * does not re-run the format check, does not re-read the scratch, and does not
   * write any new object: every artifact in the set already exists immutably, the
   * receipt is rebuilt from the recorded refs, and the only thing being finished
   * is the index flip that the interruption prevented.
   */
  private commitFrozenIntent(
    intent: PublicationCommandIntent,
    input: RegisterDiagramInput,
    expected: string,
    operationId: string,
    requestBaseHash: string,
    requestHash: string,
    frozen: PublicationArtifactIdentity[],
  ): RegisterDiagramOutput {
    const bySuffix = (suffix: string): PublicationArtifactIdentity | undefined =>
      frozen.find((a) => a.present && a.id.endsWith(suffix));
    const mainArtifact = bySuffix(`/${expected}`);
    const draftArtifact = bySuffix('/diagram-draft.json');
    if (mainArtifact === undefined || draftArtifact === undefined) {
      throw new WorkbenchContractError('ARTIFACT_CORRUPT', `operation ${operationId} is frozen without its main output or its draft; recovery cannot reconstruct the receipt`, { retryable: false, fieldPaths: ['commandId'] });
    }
    const publishedRef: WorkbenchBoundRef = { store: 'workbench', ref: { id: mainArtifact.id, sha256: mainArtifact.sha256 } };
    const draftRef: WorkbenchBoundRef = { store: 'workbench', ref: { id: draftArtifact.id, sha256: draftArtifact.sha256 } };
    const receipt = {
      operationId,
      commandId: input.commandId,
      requestHash,
      taskId: input.taskId,
      resultRefs: [publishedRef],
      reused: false,
    };
    this.coordinator.commitPublication(intent, {
      receipt: receipt as unknown as Record<string, unknown>,
      artifactSet: frozen,
      artifactSetHash: artifactSetHash(frozen),
      diagramDraftRef: draftRef,
    });
    // The legacy cache is updated as after a fresh commit; its failure cannot
    // revoke a commit the root index already published.
    try {
      const cache = this.readIndex();
      cache[canonicalCommandKey({ ownerSessionId: input.ownerSessionId, action: 'register_diagram_output', commandId: input.commandId })] = { requestBaseHash, requestHash, receipt, diagramDraftRef: draftRef };
      this.writeIndex(cache);
    } catch { /* cache only */ }
    return { receipt, diagramDraftRef: draftRef };
  }

  /**
   * The artifact set the scratch directory currently describes, or null when the
   * fixed-name output is absent. Used only to compare a retry against a FROZEN
   * set; it never decides what gets committed.
   */
  private fingerprintScratch(scratch: string, expected: string, operationId: string): PublicationArtifactIdentity[] {
    const source = path.join(scratch, expected);
    const read = (name: string): Buffer | null => {
      const file = path.join(scratch, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) return null;
        return fs.readFileSync(file);
      } catch {
        return null;
      }
    };
    const main = read(expected);
    const mapping = read('mapping.json');
    const receipt = read('validation-receipt.json');
    return [
      { id: `diagrams/${operationId}/${expected}`, sha256: main === null ? ZERO_HASH : createHash('sha256').update(main).digest('hex'), present: main !== null },
      { id: `diagrams/${operationId}/semantic-mapping.json`, sha256: mapping === null ? ZERO_HASH : createHash('sha256').update(mapping).digest('hex'), present: mapping !== null },
      { id: `diagrams/${operationId}/validation-receipt.json`, sha256: receipt === null ? ZERO_HASH : createHash('sha256').update(receipt).digest('hex'), present: receipt !== null },
    ];
  }

  /**
   * Read a COMMITTED diagram draft (SPEC section R4.1).
   *
   * The old implementation read whatever bytes sat at the ref and parsed them as
   * a draft. Three real failures followed from that: an operation whose index
   * commit had failed was still readable (the objects existed, so the read
   * succeeded); any JSON with a correct hash was accepted as a draft; and a draft
   * with a rewritten owner, task or variant was accepted because nothing compared
   * it to the identity that committed it.
   *
   * Now the ref is resolved through the v2 commit index, the object must be the
   * draft THAT operation committed, and the decoded draft must agree with its own
   * origin. A correct content hash is a necessary condition and never a
   * sufficient one.
   */
  readDraft(ref: BoundRef): AnyDiagramDraft | null {
    if (ref.store !== 'workbench') return null;
    let committed: CommittedPublication | null = null;
    try {
      const index = this.coordinator.readCommitIndex();
      for (const entry of Object.values(index.publications)) {
        const draft = entry.diagramDraftRef;
        if (draft !== undefined && draft.ref.id === ref.ref.id && draft.ref.sha256 === ref.ref.sha256) {
          committed = entry;
          break;
        }
      }
    } catch {
      // A damaged index must not degrade into "read the file and hope"; the caller
      // needs the reconciliation signal, not a plausible-looking draft.
      return null;
    }
    if (committed === null) return null;

    // Every frozen dependency of that commit must still be intact.
    for (const artifact of committed.artifactSet) {
      const bytes = this.readPublishedBytes({ store: 'workbench', ref: { id: artifact.id, sha256: artifact.sha256 } });
      if (artifact.present && bytes === null) return null;
      if (!artifact.present && bytes !== null) return null;
    }

    const bytes = this.readPublishedBytes(ref);
    if (bytes === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const draft = parsed as Partial<DiagramDraftV2>;
    // The object must be a v2 draft that names the operation which committed it.
    // Without this, a well-hashed unrelated JSON at the same ref would be returned
    // as if it were the committed draft.
    if (draft.schemaVersion !== 2) return null;
    if (draft.originOperationId !== committed.operationId) return null;
    if (typeof draft.taskId !== 'string' || draft.taskId.length === 0) return null;
    if (typeof draft.ownerSessionId !== 'string' || draft.ownerSessionId.length === 0) return null;
    if (typeof draft.candidateKey !== 'string') return null;
    if (!(draft.variantKey === null || typeof draft.variantKey === 'string')) return null;
    if (!(DIAGRAM_FORMATS as readonly string[]).includes(draft.format as string)) return null;
    if (draft.semanticHashAlgorithm !== SEMANTIC_HASH_ALGORITHM_V2) return null;
    if (!/^[0-9a-f]{64}$/.test(String(draft.semanticHash ?? ''))) return null;
    if (!Array.isArray(draft.artifactRefs) || draft.artifactRefs.length === 0) return null;
    return draft as DiagramDraftV2;
  }

  /**
   * Derive diagram status against the current structure. Agent-authored
   * validation-receipt.json is only a summary; without a separately stored,
   * Host-observed DiagramValidationWitness it cannot produce "available".
   */
  statusOf(draft: AnyDiagramDraft | null, currentSemanticHash: string): DiagramStatus {
    if (draft === null) return 'unverified';
    const witnessReadable = draft.validationWitnessRef !== null
      && this.readPublishedBytes(draft.validationWitnessRef) !== null;
    // A readable file is not itself a passing witness. Witness production and
    // independent validation are not configured in this Host build, so fail
    // closed until a trusted witness adapter is installed.
    const trustedValidationPassed = false;
    return deriveDiagramStatus({
      diagramSemanticHash: draft.semanticHash,
      currentSemanticHash,
      validationPassed: witnessReadable && trustedValidationPassed,
      validationReceiptReadable: witnessReadable && trustedValidationPassed,
    });
  }

  /**
   * Open a path only after resolving every component beneath the allowed root,
   * then read and hash the bytes from THAT descriptor (SPEC R1: handle freeze).
   *
   * The old path sequence `realpath -> stat(path) -> format(path) -> readFile(path)`
   * checked one file, then opened the name again several times. An attacker could
   * swap the file between those lookups so the format check validated A while the
   * registrar published B. One descriptor pins the object we checked and copies
   * those exact bytes into immutable storage.
   */
  private readControlledFile(root: string, file: string, maxBytes: number, label: string): Buffer {
    const resolvedRoot = safeRealpath(root);
    const resolvedFile = safeRealpath(file);
    if (resolvedRoot === null || resolvedFile === null || !isInside(resolvedRoot, resolvedFile)) {
      throw new WorkbenchContractError('POLICY_DENIED', `${label} resolves outside the assigned workspace`, { fieldPaths: ['format'] });
    }
    // realpath on Windows keeps a junction's own path, so containment alone
    // cannot see a link placed on a component; only the lstat walk can.
    assertNoReparseComponents(root, file, label);
    let fd: number;
    try {
      fd = fs.openSync(resolvedFile, 'r');
    } catch (err) {
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot open ${label}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['format'] });
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new WorkbenchContractError('INVALID_INPUT', `${label} is not a regular file`, { fieldPaths: ['format'] });
      if (stat.size === 0) throw new WorkbenchContractError('INVALID_INPUT', `${label} is empty`, { fieldPaths: ['format'] });
      if (stat.size > maxBytes) throw new WorkbenchContractError('INVALID_INPUT', `${label} is ${stat.size} bytes, exceeding the ${maxBytes}-byte limit`, { fieldPaths: ['format'] });
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (count === 0) throw new WorkbenchContractError('SOURCE_IO_ERROR', `${label} changed size while being read`, { retryable: true, fieldPaths: ['format'] });
        offset += count;
      }
      const after = fs.fstatSync(fd);
      if (after.size !== stat.size || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) {
        throw new WorkbenchContractError('SOURCE_MISMATCH', `${label} changed while it was being read; no bytes were published`, { retryable: true, fieldPaths: ['format'] });
      }
      return buffer;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Read one optional sidecar from a frozen descriptor, distinguishing absent from IO failure. */
  private readOptionalControlledFile(root: string, file: string, label: string): Buffer | null {
    try {
      fs.lstatSync(file);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot inspect ${label}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['format'] });
    }
    return this.readControlledFile(root, file, MAX_SIDECAR_BYTES, label);
  }

  private readPublishedBytes(ref: BoundRef): Buffer | null {
    if (ref.store !== 'workbench' || ref.ref.id.startsWith('missing:') || path.isAbsolute(ref.ref.id)) return null;
    const root = path.resolve(this.config.publishedRoot);
    const file = path.resolve(root, ref.ref.id);
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    try {
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(file);
      const realRelative = path.relative(realRoot, realFile);
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative) || !fs.statSync(realFile).isFile()) return null;
      const bytes = fs.readFileSync(realFile);
      return createHash('sha256').update(bytes).digest('hex') === ref.ref.sha256 ? bytes : null;
    } catch {
      return null;
    }
  }

  /** Read back a copied mapping artifact. */
  private readMapping(ref: BoundRef): SemanticMapping | null {
    const bytes = this.readPublishedBytes(ref);
    if (bytes === null) return null;
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      return parsed as SemanticMapping;
    } catch {
      return null;
    }
  }

  /** Copy a sidecar the Skill produced, or report that it is absent. */
  private copyIfPresent(destDir: string, scratch: string, sourceName: string, operationId: string, destName: string): BoundRef | null {
    const from = path.join(scratch, sourceName);
    if (!fs.existsSync(from)) return null;
    const bytes = fs.readFileSync(from);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.writeImmutableFile(path.join(destDir, destName), bytes, destName);
    return { store: 'workbench', ref: { id: `diagrams/${operationId}/${destName}`, sha256 } };
  }

  private writeDraft(draft: AnyDiagramDraft, operationId: string): WorkbenchBoundRef {
    const body = `${JSON.stringify(draft, null, 2)}\n`;
    const bytes = Buffer.from(body, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.writeImmutableFile(path.join(this.config.publishedRoot, 'diagrams', operationId, 'diagram-draft.json'), bytes, 'diagram draft');
    return { store: 'workbench', ref: { id: `diagrams/${operationId}/diagram-draft.json`, sha256 } };
  }

  /** Serialize cross-instance writers and recover only provably dead owners. */
  private withIndexLock<T>(operation: () => T): T {
    const lockFile = `${this.indexPath}.lock`;
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const nonce = randomUUID();
    const owner = { pid: process.pid, acquiredAt: new Date().toISOString(), nonce };
    const acquire = (): number => {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
        fs.fsyncSync(fd);
      } catch (err) {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockFile); } catch { /* preserve the primary error */ }
        throw err;
      }
      return fd;
    };

    let lockFd: number;
    try {
      try {
        lockFd = acquire();
      } catch (err) {
        if ((err as { code?: string }).code !== 'EEXIST') throw err;
        let existing: { pid?: number; nonce?: string };
        try { existing = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number; nonce?: string }; }
        catch {
          throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'diagram writer lock is unreadable; do not remove it without recovery review', { retryable: false, fieldPaths: ['diagramIndex'] });
        }
        if (!Number.isInteger(existing.pid) || (existing.pid ?? 0) < 1 || typeof existing.nonce !== 'string') {
          throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'diagram writer lock has invalid owner data', { retryable: false, fieldPaths: ['diagramIndex'] });
        }
        let alive = false;
        try { process.kill(existing.pid!, 0); alive = true; }
        catch (err) {
          if ((err as { code?: string }).code !== 'ESRCH') alive = true;
        }
        if (alive) {
          throw new WorkbenchContractError('HOST_BUSY', `diagram index is locked by live PID ${existing.pid}`, { retryable: true, fieldPaths: ['diagramIndex'] });
        }
        // The lock owner is provably gone. Remove only if the lock bytes are
        // still the same owner we inspected, then race to reacquire with wx.
        const current = fs.readFileSync(lockFile, 'utf8');
        if (JSON.parse(current).nonce !== existing.nonce) {
          throw new WorkbenchContractError('HOST_BUSY', 'diagram writer lock changed during stale-owner recovery', { retryable: true, fieldPaths: ['diagramIndex'] });
        }
        fs.unlinkSync(lockFile);
        try { lockFd = acquire(); }
        catch (retryErr) {
          if ((retryErr as { code?: string }).code === 'EEXIST') {
            throw new WorkbenchContractError('HOST_BUSY', 'another writer acquired the diagram index during recovery', { retryable: true, fieldPaths: ['diagramIndex'] });
          }
          throw retryErr;
        }
      }
    } catch (err) {
      if (err instanceof WorkbenchContractError) throw err;
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot acquire diagram index lock: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['diagramIndex'] });
    }

    fs.closeSync(lockFd!);
    try {
      return operation();
    } finally {
      try {
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { nonce?: string };
        if (current.nonce !== nonce) throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'diagram writer lock ownership changed before release', { fieldPaths: ['diagramIndex'] });
        fs.unlinkSync(lockFile);
      } catch (err) {
        if (err instanceof WorkbenchContractError) throw err;
        if ((err as { code?: string }).code !== 'ENOENT') {
          throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `cannot safely release diagram writer lock: ${err instanceof Error ? err.message : String(err)}`, { fieldPaths: ['diagramIndex'] });
        }
      }
    }
  }

  /** Create an immutable artifact atomically; retries may reuse only identical bytes. */
  private writeImmutableFile(file: string, bytes: Buffer, label: string): void {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const verifyExisting = (): boolean => {
      try {
        const current = fs.readFileSync(file);
        if (createHash('sha256').update(current).digest('hex') === expectedHash && current.equals(bytes)) return true;
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `${label} already exists with different bytes`, { fieldPaths: ['commandId'] });
      } catch (err) {
        if (err instanceof WorkbenchContractError) throw err;
        if ((err as { code?: string }).code === 'ENOENT') return false;
        throw err;
      }
    };
    if (verifyExisting()) return;

    const temporary = `${file}.tmp-${randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      try {
        fs.linkSync(temporary, file);
        this.fsyncDirectory(directory);
      } catch (err) {
        if ((err as { code?: string }).code !== 'EEXIST') throw err;
        if (!verifyExisting()) throw new Error('immutable destination disappeared during publication');
      }
    } catch (err) {
      if (err instanceof WorkbenchContractError) throw err;
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot publish immutable ${label}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['publication'] });
    } finally {
      if (fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* absent after link/failed create */ }
    }
  }

  private fsyncDirectory(directory: string): void {
    let fd: number | null = null;
    try {
      fd = fs.openSync(directory, 'r');
      fs.fsyncSync(fd);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'EINVAL' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') return;
      throw err;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private readIndex(): Record<string, { requestBaseHash: string; requestHash: string; receipt: RegisterDiagramOutput['receipt']; diagramDraftRef: BoundRef }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as unknown;
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return {};
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `diagram publication index is unreadable; refusing to replace it: ${err instanceof Error ? err.message : String(err)}`, { retryable: false, fieldPaths: ['diagramIndex'] });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'diagram publication index root is not an object; refusing to replace it', { retryable: false, fieldPaths: ['diagramIndex'] });
    }
    const index = parsed as Record<string, unknown>;
    for (const [key, raw] of Object.entries(index)) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `diagram publication index entry ${JSON.stringify(key)} is malformed`, { retryable: false, fieldPaths: ['diagramIndex'] });
      }
      const entry = raw as Record<string, unknown>;
      const receipt = entry.receipt as Record<string, unknown> | null;
      const draft = entry.diagramDraftRef as BoundRef | null;
      const validRef = (ref: unknown): ref is BoundRef => typeof ref === 'object' && ref !== null
        && typeof (ref as BoundRef).store === 'string'
        && typeof (ref as BoundRef).ref?.id === 'string'
        && /^[0-9a-f]{64}$/.test((ref as BoundRef).ref?.sha256 ?? '');
      if (!/^[0-9a-f]{64}$/.test(String(entry.requestBaseHash ?? ''))
        || !/^[0-9a-f]{64}$/.test(String(entry.requestHash ?? ''))
        || receipt === null || typeof receipt !== 'object'
        || typeof receipt.operationId !== 'string' || typeof receipt.commandId !== 'string'
        || typeof receipt.taskId !== 'string' || !validRef(draft)
        || !Array.isArray(receipt.resultRefs) || !receipt.resultRefs.every(validRef)) {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `diagram publication index entry ${JSON.stringify(key)} is malformed`, { retryable: false, fieldPaths: ['diagramIndex'] });
      }
    }
    return index as Record<string, { requestBaseHash: string; requestHash: string; receipt: RegisterDiagramOutput['receipt']; diagramDraftRef: BoundRef }>;
  }

  private writeIndex(index: Record<string, { requestBaseHash: string; requestHash: string; receipt: RegisterDiagramOutput['receipt']; diagramDraftRef: BoundRef }>): void {
    const directory = path.dirname(this.indexPath);
    fs.mkdirSync(directory, { recursive: true });
    const tmp = `${this.indexPath}.${randomUUID().slice(0, 8)}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8');
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, 'wx');
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.indexPath);
      this.fsyncDirectory(directory);
    } catch (err) {
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot atomically commit diagram index: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['diagramIndex'] });
    } finally {
      if (fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch { /* renamed or not created */ }
    }
  }
}

const ZERO_HASH = '0'.repeat(64);

/**
 * The element → semantic-id mapping a diagram Skill writes.
 *
 * Both arrays are accepted because a drawing tool may key by element id while a
 * renderer keys by a stable label; requiring one shape would make the Skill
 * reshape its output to satisfy this checker rather than to describe its diagram.
 */
export interface SemanticMapping {
  schemaVersion?: 2;
  semanticGraphRef?: BoundRef;
  semanticHash?: string;
  /** Diagram element id → semantic node id. */
  nodes?: Record<string, string>;
  /** Diagram element id → semantic edge id. */
  edges?: Record<string, string>;
  /** Semantic node id → the exact Host label carried by this graph. */
  labels?: Record<string, string>;
  /** Semantic edge id → exact directed node and port endpoints. */
  edgeEndpoints?: Record<string, { source: string; sourcePort: string; target: string; targetPort: string; relation?: 'tensor' | 'supervision' | 'control' }>;
  /** Legacy witness field retained for diagnostic compatibility only. */
  edgeOrder?: Record<string, 'source' | 'target'>;
}

export interface SemanticMappingContext {
  semanticGraphRef: BoundRef;
  semanticHash: string;
  expectedNodeLabels: Record<string, string>;
  expectedEdgeEndpoints: Record<string, { source: string; sourcePort: string; target: string; targetPort: string; relation?: 'tensor' | 'supervision' | 'control' }>;
}

/**
 * Check a mapping against the structure the diagram claims to depict.
 *
 * Three failure modes, each a way a diagram can silently become a different
 * structure while keeping the same semantic hash:
 *  - a KNOWN node or edge is missing from the diagram;
 *  - an edge's direction is REVERSED (its endpoints are swapped);
 *  - a known label was changed.
 *
 * An empty expectation list means the Host supplied no structure, so there is
 * nothing to check; that is reported by returning no defects, and callers
 * distinguish it from a real pass by whether they supplied ids at all.
 */
export function verifyMapping(
  mapping: SemanticMapping,
  expectedNodeIds: string[],
  expectedEdgeIds: string[],
  context?: SemanticMappingContext,
): string[] {
  const defects: string[] = [];
  const nodes = mapping.nodes ?? {};
  const edges = mapping.edges ?? {};
  const labels = mapping.labels ?? {};
  const expectedNodes = new Set(expectedNodeIds);
  const expectedEdges = new Set(expectedEdgeIds);

  if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) defects.push('nodes 必须是 elementId → semanticNodeId 对象');
  if (typeof edges !== 'object' || edges === null || Array.isArray(edges)) defects.push('edges 必须是 elementId → semanticEdgeId 对象');
  const nodeValues = Object.values(nodes);
  const edgeValues = Object.values(edges);
  for (const id of expectedNodeIds) if (!nodeValues.includes(id)) defects.push(`图稿缺少语义节点 ${id}`);
  for (const id of nodeValues) if (!expectedNodes.has(id)) defects.push(`图稿包含未知语义节点 ${String(id)}`);
  for (const id of expectedEdgeIds) if (!edgeValues.includes(id)) defects.push(`图稿缺少语义边 ${id}`);
  for (const id of edgeValues) if (!expectedEdges.has(id)) defects.push(`图稿包含未知语义边 ${String(id)}`);

  // Mapping is bijective: one visual element per semantic identity, no aliases.
  const counts = new Map<string, number>();
  for (const v of nodeValues) if (typeof v === 'string') counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [id, n] of counts) if (n > 1) defects.push(`语义节点 ${id} 被 ${n} 个图元重复指代`);
  const edgeCounts = new Map<string, number>();
  for (const v of edgeValues) if (typeof v === 'string') edgeCounts.set(v, (edgeCounts.get(v) ?? 0) + 1);
  for (const [id, n] of edgeCounts) if (n > 1) defects.push(`语义边 ${id} 被 ${n} 个图元重复指代`);

  for (const [id, value] of Object.entries(labels)) {
    if (typeof value !== 'string' || value.trim().length === 0) defects.push(`语义节点 ${id} 的标签为空`);
  }
  if (context !== undefined) {
    const allowedRootKeys = new Set(['schemaVersion', 'semanticGraphRef', 'semanticHash', 'nodes', 'edges', 'labels', 'edgeEndpoints']);
    for (const key of Object.keys(mapping as Record<string, unknown>)) if (!allowedRootKeys.has(key)) defects.push(`mapping 包含未声明字段 ${key}`);
    if (mapping.schemaVersion !== 2) defects.push('mapping.schemaVersion 必须为 2');
    if (mapping.semanticHash !== context.semanticHash || !/^[0-9a-f]{64}$/.test(mapping.semanticHash ?? '')) defects.push('mapping.semanticHash 与 Host 当前 semanticHash 不匹配');
    const mappedRef = mapping.semanticGraphRef;
    if (
      mappedRef?.store !== context.semanticGraphRef.store
      || mappedRef?.ref?.id !== context.semanticGraphRef.ref.id
      || mappedRef?.ref?.sha256 !== context.semanticGraphRef.ref.sha256
    ) defects.push('mapping.semanticGraphRef 与 Host 当前 GraphSnapshot 不匹配');

    const labelIds = Object.keys(labels).sort();
    const expectedLabelIds = Object.keys(context.expectedNodeLabels).sort();
    if (JSON.stringify(labelIds) !== JSON.stringify(expectedLabelIds)) defects.push('mapping.labels 必须逐一覆盖且仅覆盖当前语义节点');
    for (const [id, expected] of Object.entries(context.expectedNodeLabels)) {
      if (labels[id] !== expected) defects.push(`语义节点 ${id} 的 Host 标签被遗漏或篡改`);
    }

    const endpoints = mapping.edgeEndpoints ?? {};
    const endpointIds = Object.keys(endpoints).sort();
    const expectedEndpointIds = Object.keys(context.expectedEdgeEndpoints).sort();
    if (JSON.stringify(endpointIds) !== JSON.stringify(expectedEndpointIds)) defects.push('mapping.edgeEndpoints 必须逐一覆盖且仅覆盖当前语义边');
    for (const [id, expected] of Object.entries(context.expectedEdgeEndpoints)) {
      const actual = endpoints[id];
      if (actual === undefined || actual.source !== expected.source || actual.sourcePort !== expected.sourcePort || actual.target !== expected.target || actual.targetPort !== expected.targetPort || (expected.relation !== undefined && actual.relation !== expected.relation)) {
        defects.push(`语义边 ${id} 的有向端点、端口或关系与 Host 图不匹配`);
      }
    }
  }
  return defects;
}

interface ParsedDiagramSemantics {
  nodes: Record<string, string>;
  edges: Record<string, string>;
  labels: Record<string, string>;
  edgeEndpoints: Record<string, { source: string; sourcePort: string; target: string; targetPort: string; relation?: 'tensor' | 'supervision' | 'control' }>;
}

/** Parse only the explicit Archify SVG metadata contract; never execute HTML. */
function parseArchifySvgSemantics(bytes: Buffer): { semantics: ParsedDiagramSemantics | null; defects: string[] } {
  const html = bytes.toString('utf8');
  const svgs = [...html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi)].map((match) => match[0]);
  if (svgs.length === 0) return { semantics: null, defects: ['Archify 输出没有可读取的 SVG 根元素'] };
  const semantics: ParsedDiagramSemantics = { nodes: {}, edges: {}, labels: {}, edgeEndpoints: {} };
  const defects: string[] = [];
  const attr = (text: string, name: string): string | null => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    const raw = match?.[1] ?? match?.[2];
    if (raw === undefined) return null;
    return raw.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_whole, code: string) => {
      if (code.toLowerCase() === 'amp') return '&';
      if (code.toLowerCase() === 'lt') return '<';
      if (code.toLowerCase() === 'gt') return '>';
      if (code.toLowerCase() === 'quot') return '"';
      if (code.toLowerCase() === 'apos') return "'";
      const number = code.startsWith('#x') || code.startsWith('#X') ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _whole;
    });
  };
  for (const svg of svgs) {
    for (const match of svg.matchAll(/<([A-Za-z][\w:-]*)\b([^<>]*?)\/?>/g)) {
      const tag = (match[1] ?? '').toLowerCase();
      const attributes = match[2] ?? '';
      const elementId = attr(attributes, 'data-element-id');
      const semanticNodeId = attr(attributes, 'data-semantic-node-id');
      const semanticEdgeId = attr(attributes, 'data-semantic-edge-id');
      const classes = attr(attributes, 'class') ?? '';
      if ((/\bnode\b/i.test(classes) && semanticNodeId === null) || (/\b(?:edge|edgepath)\b/i.test(classes) && semanticEdgeId === null)) {
        defects.push('Archify 存在未绑定语义 ID 的 node/edge 图元');
      }
      if (semanticNodeId !== null) {
        if (tag !== 'g' || elementId === null || elementId.length === 0) {
          defects.push('Archify 语义节点必须是带 data-element-id 的 <g> 主图元');
          continue;
        }
        if (/display\s*=\s*["']none|visibility\s*=\s*["']hidden|(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(attributes)) {
          defects.push(`Archify 语义节点 ${elementId} 是隐藏图元`);
          continue;
        }
        const label = attr(attributes, 'data-label');
        if (label === null || label.trim().length === 0) {
          defects.push(`Archify 语义节点 ${elementId} 缺少可见 data-label`);
          continue;
        }
        if (Object.hasOwn(semantics.nodes, elementId)) defects.push(`Archify 重复 data-element-id ${elementId}`);
        semantics.nodes[elementId] = semanticNodeId;
        semantics.labels[semanticNodeId] = label;
      }
      if (semanticEdgeId !== null) {
        if (!['path', 'line', 'polyline'].includes(tag) || elementId === null || elementId.length === 0) {
          defects.push('Archify 语义边必须是带 data-element-id 的 path/line/polyline 主图元');
          continue;
        }
        if (/display\s*=\s*["']none|visibility\s*=\s*["']hidden|(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(attributes)) {
          defects.push(`Archify 语义边 ${elementId} 是隐藏图元`);
          continue;
        }
        const source = attr(attributes, 'data-source-node-id');
        const sourcePort = attr(attributes, 'data-source-port');
        const target = attr(attributes, 'data-target-node-id');
        const targetPort = attr(attributes, 'data-target-port');
        const relation = attr(attributes, 'data-relation');
        if (source === null || sourcePort === null || target === null || targetPort === null || !['tensor', 'supervision', 'control'].includes(relation ?? '')) {
          defects.push(`Archify 语义边 ${elementId} 缺少有向端点、端口或 relation`);
          continue;
        }
        if (Object.hasOwn(semantics.edges, elementId)) defects.push(`Archify 重复 data-element-id ${elementId}`);
        semantics.edges[elementId] = semanticEdgeId;
        semantics.edgeEndpoints[semanticEdgeId] = { source, sourcePort, target, targetPort, relation: relation as 'tensor' | 'supervision' | 'control' };
      }
    }
  }
  return { semantics, defects };
}

/** Parse Excalidraw elements, text containers and arrow start/end bindings. */
function parseExcalidrawSemantics(bytes: Buffer): { semantics: ParsedDiagramSemantics | null; defects: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return { semantics: null, defects: ['Excalidraw 产出不是可解析的 JSON'] };
  }
  const doc = parsed as { type?: unknown; elements?: unknown };
  if (doc.type !== 'excalidraw' || !Array.isArray(doc.elements)) {
    return { semantics: null, defects: ['Excalidraw 产出缺少 elements 数组'] };
  }
  const semantics: ParsedDiagramSemantics = { nodes: {}, edges: {}, labels: {}, edgeEndpoints: {} };
  const defects: string[] = [];
  const live = doc.elements.filter((element): element is Record<string, unknown> => {
    if (typeof element !== 'object' || element === null) return false;
    return (element as Record<string, unknown>).isDeleted !== true;
  });
  const byId = new Map<string, Record<string, unknown>>();
  for (const element of live) {
    const id = element.id;
    if (typeof id !== 'string' || id.length === 0) {
      defects.push('Excalidraw 存在没有 id 的图元');
      continue;
    }
    byId.set(id, element);
    if (element.opacity === 0) defects.push(`Excalidraw 图元 ${id} 是隐藏占位（opacity 0）`);
  }
  const custom = (element: Record<string, unknown>): Record<string, unknown> =>
    typeof element.customData === 'object' && element.customData !== null && !Array.isArray(element.customData)
      ? element.customData as Record<string, unknown>
      : {};
  for (const element of live) {
    const id = element.id as string;
    if (byId.get(id) !== element) continue;
    const data = custom(element);
    const nodeId = typeof data.semanticNodeId === 'string' && data.semanticNodeId.length > 0 ? data.semanticNodeId : null;
    const edgeId = typeof data.semanticEdgeId === 'string' && data.semanticEdgeId.length > 0 ? data.semanticEdgeId : null;
    if (nodeId !== null) {
      if (Object.hasOwn(semantics.nodes, id)) defects.push(`Excalidraw 重复图元 id ${id}`);
      semantics.nodes[id] = nodeId;
    }
    if (edgeId !== null) {
      if (!['arrow', 'line'].includes(String(element.type))) {
        defects.push(`Excalidraw 语义边 ${id} 不是 arrow/line 图元`);
        continue;
      }
      const startBinding = element.startBinding as { elementId?: unknown } | null | undefined;
      const endBinding = element.endBinding as { elementId?: unknown } | null | undefined;
      const sourceElement = startBinding?.elementId;
      const targetElement = endBinding?.elementId;
      if (typeof sourceElement !== 'string' || typeof targetElement !== 'string') {
        defects.push(`Excalidraw 语义边 ${id} 缺少 start/end binding`);
        continue;
      }
      const source = semantics.nodes[sourceElement];
      const target = semantics.nodes[targetElement];
      if (source === undefined || target === undefined) {
        defects.push(`Excalidraw 语义边 ${id} 的绑定图元未声明 semanticNodeId`);
        continue;
      }
      const sourcePort = typeof data.sourcePort === 'string' ? data.sourcePort : null;
      const targetPort = typeof data.targetPort === 'string' ? data.targetPort : null;
      const relation = typeof data.relation === 'string' ? data.relation : null;
      if (sourcePort === null || targetPort === null || !['tensor', 'supervision', 'control'].includes(relation ?? '')) {
        defects.push(`Excalidraw 语义边 ${id} 缺少端口或 relation`);
        continue;
      }
      if (Object.hasOwn(semantics.edges, id)) defects.push(`Excalidraw 重复图元 id ${id}`);
      semantics.edges[id] = edgeId;
      semantics.edgeEndpoints[edgeId] = { source, sourcePort, target, targetPort, relation: relation as 'tensor' | 'supervision' | 'control' };
    }
  }
  for (const element of live) {
    const data = custom(element);
    const nodeId = typeof data.semanticNodeId === 'string' ? data.semanticNodeId : null;
    if (nodeId === null) continue;
    const container = typeof element.id === 'string' ? element.id : '';
    const boundTextIds = Array.isArray(element.boundElements)
      ? (element.boundElements as Array<{ id?: unknown; type?: unknown }>).filter((entry) => entry.type === 'text' && typeof entry.id === 'string').map((entry) => entry.id as string)
      : [];
    const texts: string[] = [];
    for (const textId of boundTextIds) {
      const textElement = byId.get(textId);
      const text = textElement?.text;
      if (typeof text === 'string' && text.trim().length > 0) texts.push(text.trim());
    }
    if (texts.length === 0) {
      defects.push(`Excalidraw 语义节点 ${container} 缺少绑定文本容器`);
      continue;
    }
    semantics.labels[nodeId] = texts.join(' ');
  }
  return { semantics, defects };
}

function compareParsedDiagramToMapping(parsed: ParsedDiagramSemantics, mapping: SemanticMapping): string[] {
  const defects: string[] = [];
  const equalRecord = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
    JSON.stringify(Object.entries(a).sort(([ka], [kb]) => ka.localeCompare(kb)))
      === JSON.stringify(Object.entries(b).sort(([ka], [kb]) => ka.localeCompare(kb)));
  if (!equalRecord(parsed.nodes, mapping.nodes ?? {})) defects.push('Archify SVG 的实际节点图元与 mapping.nodes 不一致');
  if (!equalRecord(parsed.edges, mapping.edges ?? {})) defects.push('Archify SVG 的实际边图元与 mapping.edges 不一致');
  if (!equalRecord(parsed.labels, mapping.labels ?? {})) defects.push('Archify SVG 的实际文本标签与 mapping.labels 不一致');
  if (!equalRecord(parsed.edgeEndpoints, mapping.edgeEndpoints ?? {})) defects.push('Archify SVG 的实际有向端点与 mapping.edgeEndpoints 不一致');
  return defects;
}

/**
 * Detect a REVERSED edge in a mapping that records endpoints.
 *
 * Kept separate because a renderer may or may not record direction; when it
 * does, a swapped pair is the single most common way a diagram misrepresents a
 * pipeline without changing its node set.
 */
export function findReversedEdge(mapping: SemanticMapping, edgeEndpoints: Array<{ id: string; source: string; target: string }>): string | null {
  const recorded = mapping.edges ?? {};
  const pairs = new Map<string, string[]>();
  for (const [elementId, semanticId] of Object.entries(recorded)) {
    const list = pairs.get(semanticId) ?? [];
    list.push(elementId);
    pairs.set(semanticId, list);
  }
  for (const edge of edgeEndpoints) {
    const elements = pairs.get(edge.id);
    if (elements === undefined || elements.length === 0) continue;
    // With one element per edge there is nothing to compare; with two, they must
    // not both name the same endpoint twice in swapped order.
    if (elements.length === 2) {
      const [a, b] = elements as [string, string];
      if (mapping.edgeOrder?.[a] !== undefined && mapping.edgeOrder[b] !== undefined) {
        const orderA = mapping.edgeOrder[a];
        const orderB = mapping.edgeOrder[b];
        if (orderA === 'target' && orderB === 'source') return edge.id;
      }
    }
  }
  return null;
}

/** Cheap content check: the bytes must at least look like the declared format. */
function assertFormat(bytes: Buffer, format: DiagramFormat): void {
  const head = bytes.subarray(0, 512).toString('utf8');
  if (format === 'archify_html') {
    if (!/<html|<!doctype html/i.test(head)) {
      throw new WorkbenchContractError('INVALID_INPUT', 'archify_html 产出不是 HTML', { fieldPaths: ['format'] });
    }
    return;
  }
  if (format === 'excalidraw') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new WorkbenchContractError('INVALID_INPUT', 'excalidraw 产出不是 JSON', { fieldPaths: ['format'] });
    }
    const doc = parsed as { type?: unknown; version?: unknown; elements?: unknown };
    if (doc.type !== 'excalidraw') {
      throw new WorkbenchContractError('INVALID_INPUT', 'excalidraw 产出的 type 字段不是 "excalidraw"', { fieldPaths: ['format'] });
    }
    if (!Array.isArray(doc.elements)) {
      throw new WorkbenchContractError('INVALID_INPUT', 'excalidraw 产出没有 elements 数组', { fieldPaths: ['format'] });
    }
  }
}

function safeRealpath(target: string): string | null {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return null;
  }
}

function isInside(root: string, child: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(child);
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Detect a reparse point (Windows junction or symlink) at `file`.
 *
 * On Node 24 for Windows, `fs.lstatSync` follows a JUNCTION and reports the
 * target's own directory entry -- `isSymbolicLink()` is false and the identity
 * matches the target -- so neither lstat nor a stat/lstat comparison can see the
 * link. Reading the PARENT directory with `withFileTypes` is the reliable probe:
 * a directory entry for a junction IS reported as a symbolic link there.
 */
function isReparsePoint(file: string): boolean {
  const resolved = path.resolve(file);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) return true;
  } catch {
    return false;
  }
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.name === base) return entry.isSymbolicLink();
    }
    return false;
  } catch {
    // No readable parent (the component was removed mid-walk): fail closed, the
    // caller's own existsSync check will produce the precise refusal.
    return false;
  }
}

/**
 * Refuse when ANY path component between the root and the file is a reparse
 * point (a Windows junction or a symlink).
 *
 * Rationale: `fs.realpathSync` on Windows does NOT resolve a junction placed on
 * one of the components -- the resolved string keeps the junction's own path, so
 * a realpath-containment check compares the junction's NAME against the root and
 * happily approves a workspace whose contents live somewhere else entirely. That
 * is exactly the whole-workspace escape. Walking the components and testing the
 * reparse-point bit is the only check that sees the junction itself.
 */
function assertNoReparseComponents(root: string, file: string, label: string): void {
  const rootResolved = path.resolve(root);
  const fileResolved = path.resolve(file);
  if (!isInside(rootResolved, fileResolved)) {
    throw new WorkbenchContractError('POLICY_DENIED', `${label} is not inside the assigned workspace`, { fieldPaths: ['format'] });
  }
  const relative = path.relative(rootResolved, fileResolved);
  const segments = relative.split(path.sep).filter((s) => s.length > 0);
  let walked = rootResolved;
  // The root itself is included: a junction ON the workspace directory is the
  // escape this guard exists for.
  for (const segment of ['', ...segments]) {
    if (segment !== '') walked = path.join(walked, segment);
    if (!fs.existsSync(walked)) {
      // A missing component fails later with the precise DEPENDENCY_NOT_READY.
      return;
    }
    if (isReparsePoint(walked)) {
      throw new WorkbenchContractError('POLICY_DENIED', `${label} 通过链接（junction/symlink）重定向到工作区之外，拒绝登记`, { fieldPaths: ['format'] });
    }
  }
}

function describeDir(dir: string): string {
  try {
    return fs.readdirSync(dir).join(', ') || '(空)';
  } catch {
    return '(不可读)';
  }
}

/** Helper for tests and for the tool: the refs a registration produced. */
export function draftArtifactRefs(ref: BoundRef): StrictArtifactRef[] {
  return [ref.ref];
}
