/**
 * Builds fixtures/phase2-source-pack/manifest.json from the real state of this repository.
 *
 * Why a builder instead of a hand-written manifest
 * ------------------------------------------------
 * Every digest in the manifest is derived at build time from bytes on disk, from real `git`
 * objects, or from the real ZIP central directory. No hash is typed by hand, so the manifest
 * cannot claim a pin that the files do not actually satisfy. `scripts/verify-phase2-sources.ts`
 * then re-derives the same values independently and fails on any drift.
 *
 * What it deliberately refuses to do
 * ----------------------------------
 *   * It never invents a remote URL. This checkout has no git remote configured, so `sourceUri`
 *     names the local checkout and the missing upstream is recorded in `unresolved`.
 *   * It never invents a license. No LICENSE/COPYING/NOTICE file exists outside node_modules, so
 *     `licenseRef` is the literal `no-license-declared` and the gap is recorded in `unresolved`.
 *   * It never reads evaluation gold. It touches no path under data/sealed/gold, fixtures/ *&#47;gold
 *     or fixtures/ *&#47;review; the only archive it opens is the in-repo academic_stitch_mvp.zip.
 *
 * Usage (from a checkout that still has git history):
 *   node --experimental-strip-types fixtures/phase2-source-pack/build-manifest.ts
 *
 * RELEASE-TREE LIMITATION (read this before running it here)
 * ----------------------------------------------------------
 * Every `sourceKind: vcs` pin below is derived from real `git` objects 鈥?the
 * commit that last touched each file, its blob sha1, and the tree object a
 * consumer would check out. That is the whole point: the manifest must not claim
 * a pin the bytes do not satisfy.
 *
 * This release tree is exported WITHOUT `.git` (see the Beta release Plan 搂3), so
 * this builder cannot run inside it and will fail with
 * "fatal: not a git repository". That is the honest outcome, not a bug to paper
 * over: `manifest.json` is shipped as a FROZEN artifact, and re-deriving it
 * requires the source history. Rebuild it in a git checkout and copy the result
 * across; do not hand-edit the digests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  computeSourceBundleHash,
  sourceBundleBody,
  validateSourceBundle,
  type SourceBundle,
  type SourceEntry,
} from '../../packages/evolver/src/contracts/experiments.ts';
import { readZipEntries, sha256Hex, type ZipEntryRecord } from './tools/zip-entries.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PACK_DIR = path.join(REPO_ROOT, 'fixtures', 'phase2-source-pack');
/**
 * Value written to sourceUri for entries pinned from this checkout.
 *
 * NOT a URL. The contract only requires a non-empty string
 * (contracts/experiments.ts, expAssertId) and nothing parses it as one, so a
 * location-free marker is both valid and honest: a ile:// URL would claim a path
 * that is false in any other checkout (and leak the author's disk layout), while an
 * https:// URL would claim an upstream this checkout never had. The commit,
 * contentHash and tree values below are the real pins.
 *
 * Keep in sync with scripts/release/neutralize-fixture-provenance.mjs, which
 * rewrites the frozen manifest.json the same way.
 */
const SOURCE_CHECKOUT_MARKER = 'repo-relative:source-checkout';
const MANIFEST_PATH = path.join(PACK_DIR, 'manifest.json');

const NO_LICENSE = 'no-license-declared';

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}

function gitBuffer(args: string[]): Buffer {
  return execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 1 << 28 });
}

function gitOrNull(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

interface PinnedFile {
  path: string;
  role: string;
  sha256: string;
  bytes: number;
  gitBlobSha1: string;
  commit: string;
  treeRef: string;
  /** Byte-for-byte equality between the working tree and the recorded blob at `commit`. */
  blobMatchesWorkingTree: boolean;
}

/** Resolves one repo-relative file to its real git identity and on-disk digest. */
function pinFile(repoRelPath: string, role: string): PinnedFile {
  const abs = path.join(REPO_ROOT, repoRelPath);
  const bytes = fs.readFileSync(abs);
  const commit = git(['log', '-1', '--format=%H', '--', repoRelPath]);
  if (!commit) throw new Error(`no commit records ${repoRelPath}; it is untracked and cannot be pinned as vcs`);
  const blobSha1 = git(['rev-parse', `${commit}:${repoRelPath}`]);
  const blob = gitBuffer(['cat-file', '-p', `${commit}:${repoRelPath}`]);
  return {
    path: repoRelPath,
    role,
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    gitBlobSha1: blobSha1,
    commit,
    treeRef: path.posix.dirname(repoRelPath),
    blobMatchesWorkingTree: blob.equals(bytes),
  };
}

/** The subtree object at `commit`, so a consumer can check out the pin and get these bytes. */
function treeObjectId(commit: string, treeRef: string): string {
  return git(['rev-parse', `${commit}:${treeRef}`]);
}

function isAncestorOfHead(commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

function artifactRefOf(repoRelPath: string): { id: string; sha256: string } {
  return { id: repoRelPath, sha256: sha256Hex(fs.readFileSync(path.join(REPO_ROOT, repoRelPath))) };
}

interface ArchivePin {
  entry: SourceEntry;
  archivePath: string;
  archiveSha256: string;
  archiveBytes: number;
  containerEntries: ZipEntryRecord[];
  inBundle: false;
  inBundleReason: string;
  modelReadable: boolean;
  modelReadableReason: string;
}

function buildArchivePin(): ArchivePin {
  const archivePath = 'work/incoming/academic_stitch_mvp.zip';
  const abs = path.join(REPO_ROOT, archivePath);
  const bytes = fs.readFileSync(abs);
  const contentHash = sha256Hex(bytes);
  const containerEntries = readZipEntries(bytes);

  // The declared contentHash must equal the real archive digest, and the archive must be the
  // same object the existing MVP pack already recorded, or the pin is not corroborated.
  const mvpManifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'mvp-source-pack', 'manifest.json'), 'utf8')
  ) as { sourceArchive?: { sha256?: string } };
  const corroboratedBy = mvpManifest.sourceArchive?.sha256 ?? null;

  return {
    entry: {
      id: 'phase2-archive-academic-stitch-mvp',
      role: 'module',
      sourceKind: 'offline_archive',
      sourceUri: `${SOURCE_CHECKOUT_MARKER}/${archivePath}`,
      commit: null,
      contentHash,
      treeRef: 'mnt/data/academic_stitch_mvp',
      entrypoint: 'mnt/data/academic_stitch_mvp/toy_model.py',
      licenseRef: NO_LICENSE,
      weightRefs: [],
    },
    archivePath,
    archiveSha256: contentHash,
    archiveBytes: bytes.length,
    containerEntries,
    inBundle: false,
    inBundleReason:
      'Its entrypoint lives inside the archive, not on disk, so no runner can import it by path. ' +
      'Recording it as a bundle module would claim a runnable source that does not exist. It is pinned ' +
      'as provenance for the ASPP/SE paper snapshots instead.',
    modelReadable: false,
    modelReadableReason:
      'work/incoming is listed in fixtures/paper-only-v1/isolation/readable-roots.json deniedPaths, so the ' +
      'model-side isolation protocol cannot read it. This pin is a host-side record; the verifier that ' +
      'recomputes it is a host tool, not a model-side read.',
  };
}

/** Reads the archived REAL P6 product; never regenerates it. */
function readArchivedResearchCandidate(): {
  candidate: { id: string; candidateHash: string };
  resultRef: { id: string; sha256: string };
} {
  const rel = 'work/phase2-candidate-2026-10-06/p6-synthesis-result.json';
  const abs = path.join(REPO_ROOT, rel);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as {
    candidates: Array<{ id: string; candidateHash: string }>;
  };
  const candidate = raw.candidates.find((c) => c.id === 'candidate-P002');
  if (!candidate) throw new Error(`candidate-P002 is not in the archived P6 result (${rel})`);
  return {
    candidate,
    resultRef: { id: rel, sha256: sha256Hex(fs.readFileSync(abs)) },
  };
}

function main(): void {
  const head = git(['rev-parse', 'HEAD']);

  // ---- baseline: the fixed stitch-cpu-v1 model + its deterministic data generator ----
  const baselineModel = pinFile('experiments/stitch-cpu-v1/model.py', 'entrypoint');
  const baselineData = pinFile('experiments/stitch-cpu-v1/data.py', 'pinned-dependency');
  const baselineWeight = pinFile('artifacts/weights/baseline_seed20260929.pt', 'weight');
  const baselineCommit = baselineModel.commit;

  const baselineEntry: SourceEntry = {
    id: 'phase2-baseline-stitch-cpu-v1',
    role: 'baseline',
    sourceKind: 'vcs',
    sourceUri: SOURCE_CHECKOUT_MARKER,
    commit: baselineCommit,
    contentHash: null,
    treeRef: 'experiments/stitch-cpu-v1',
    entrypoint: baselineModel.path,
    licenseRef: NO_LICENSE,
    weightRefs: [baselineWeight.path],
  };

  // ---- modules: the real in-repo module implementations ----
  const asppFile = pinFile('fixtures/modules/aspp_block.py', 'entrypoint');
  const seFile = pinFile('fixtures/modules/se_block.py', 'entrypoint');
  const attentionGateFile = pinFile('fixtures/modules/attention_gate_block.py', 'entrypoint');
  const modulesManifest = pinFile('fixtures/modules/manifest.json', 'pinned-dependency');

  const asppEntry: SourceEntry = {
    id: 'phase2-module-aspp-v1',
    role: 'module',
    sourceKind: 'vcs',
    sourceUri: SOURCE_CHECKOUT_MARKER,
    commit: asppFile.commit,
    contentHash: null,
    treeRef: 'fixtures/modules',
    entrypoint: asppFile.path,
    licenseRef: NO_LICENSE,
    weightRefs: [],
  };
  const seEntry: SourceEntry = {
    id: 'phase2-module-se-v1',
    role: 'module',
    sourceKind: 'vcs',
    sourceUri: SOURCE_CHECKOUT_MARKER,
    commit: seFile.commit,
    contentHash: null,
    treeRef: 'fixtures/modules',
    entrypoint: seFile.path,
    licenseRef: NO_LICENSE,
    weightRefs: [],
  };
  // The attention gate is the FIRST pinned module with a research-card provenance: it implements
  // the mechanism the real P5 card P002 describes, and the Phase 3 pilot binds it through the
  // real P6 candidate. The pin records the same honesty the others carry (own implementation,
  // no upstream code) 閳?it does NOT claim the paper's reported numbers are reproduced.
  const attentionGateEntry: SourceEntry = {
    id: 'phase2-module-attention-gate-v1',
    role: 'module',
    sourceKind: 'vcs',
    sourceUri: SOURCE_CHECKOUT_MARKER,
    commit: attentionGateFile.commit,
    contentHash: null,
    treeRef: 'fixtures/modules',
    entrypoint: attentionGateFile.path,
    licenseRef: NO_LICENSE,
    weightRefs: [],
  };

  const dataManifestRef = artifactRefOf('fixtures/phase2-source-pack/data/data-manifest.json');
  const environmentRef = artifactRefOf('fixtures/phase2-source-pack/environment.json');
  const proposalRef = artifactRefOf('docs/mvp/phases/PHASE2-RPD.md');

  const unresolved = [
    'NO-LICENSE: this repository contains no LICENSE, COPYING or NOTICE file outside node_modules, so ' +
      'every entry carries licenseRef="no-license-declared". Under PHASE2-DATA-REQUEST section 1.5 that ' +
      'means all rights reserved by default and the sources must not be treated as freely reusable.',
    'NO-REMOTE: `git remote -v` is empty for this checkout, so no public upstream URL or upstream commit ' +
      'can be recorded. sourceUri names the local checkout only and the commits are local commit ids.',
    'NO-UPSTREAM-CODE: fixtures/modules/aspp_block.py, se_block.py and attention_gate_block.py are this ' +
      'repository\'s own 8-channel simplified implementations. They are not the DeepLabv3, SENet or ' +
      'attention-gate paper official code; arXiv:1706.05587, arXiv:1709.01507 and the P5 research card ' +
      'paper-only-v1-module-P002-83368396d7b6 are recorded only as the mechanism reference, per ' +
      'PHASE2-DATA-REQUEST section 1.2.',
    'NO-LOCKFILE: no pnpm-lock.yaml, package-lock.json, requirements.txt or environment.yml exists, so no ' +
      'dependency closure is pinned. PHASE2-SPEC section 5 asks the environment record to carry a package ' +
      'lock; fixtures/phase2-source-pack/environment.json records its absence instead of a fabricated digest.',
    'NO-TEST-SPLIT: Phase 2 declares no test split, so the data slice has train and validation only. A test ' +
      'handle belongs to the Phase 3 DataSplitManifest and was not manufactured here.',
    'CANDIDATE-BOUND-P002: fixtures/modules/attention_gate_block.py is bound to the REAL P5 research card ' +
      'paper-only-v1-module-P002-83368396d7b6 (published by operation rop-p5_discover-3b3dc696e35e1390) and to the ' +
      'REAL P6 candidate candidate-P002 (work/phase2-candidate-2026-10-06/p6-synthesis-result.json). The binding is ' +
      'recorded on the module manifest entry; the implementation is still this repository\'s own code, not the paper\'s.',
  ];

  const bundleBody: Omit<SourceBundle, 'sourceBundleHash'> = {
    schemaVersion: 1,
    proposal: {
      kind: 'manual',
      proposalRef: { id: proposalRef.id, sha256: proposalRef.sha256 },
      selectionReason:
        'Workstream A (閺夈儲绨稉搴㈡殶閹诡喖鍣径? of PHASE2-RPD "Worker 瀵偓瀹搞儴绔熼悾? row 1: verify code/license/version and ' +
        'prepare the small data slice, preprocessing and manifest before a candidate exists. The contract this ' +
        'pack is built against is docs/mvp/phases/PHASE2-SPEC.md section 2 (SourceBundle).',
    },
    baseline: baselineEntry,
    modules: [asppEntry, seEntry, attentionGateEntry],
    dataRef: { id: 'phase2-cpu-slice-v1', sha256: dataManifestRef.sha256 },
    environmentRef: { id: 'phase2-cpu-env-v1', sha256: environmentRef.sha256 },
    qualityStatus: 'provisional',
    unresolved,
  };
  const sourceBundle: SourceBundle = {
    ...bundleBody,
    sourceBundleHash: computeSourceBundleHash(bundleBody as unknown as Record<string, unknown>),
  };

  // Fail fast if what we just built does not satisfy the frozen contract.
  validateSourceBundle(sourceBundle, 'manifest.bundle');

  // ---- The Phase 3 research bundle, over the SAME pinned source entries ----
  // The manual bundle above is the Phase 2 record and stays exactly as it was.
  // This one differs in ONE field 閳?`proposal` 閳?to bind the archived REAL P6
  // candidate-P002 to the pinned attention gate, which is what the Phase 3 MVP
  // gate asks for (SPEC section 0.1/9.3, P3H-03). The source entries, the data
  // ref, the environment ref and the unresolved list are the same objects, so
  // the two bundles are comparable rather than two different source claims.
  const researchCandidate = readArchivedResearchCandidate();
  const researchBundleBody: Omit<SourceBundle, 'sourceBundleHash'> = {
    ...bundleBody,
    proposal: {
      // Exactly the three research fields, nothing else: the frozen contract
      // refuses a research link that carries proposalRef OR selectionReason
      // (both are manual-only). The reason this binding exists lives in
      // bundle.unresolved (CANDIDATE-BOUND-P002) instead.
      kind: 'research',
      synthesisResultRef: researchCandidate.resultRef,
      candidateId: researchCandidate.candidate.id,
      candidateHash: researchCandidate.candidate.candidateHash,
    },
  };
  const researchBundle: SourceBundle = {
    ...researchBundleBody,
    sourceBundleHash: computeSourceBundleHash(researchBundleBody as unknown as Record<string, unknown>),
  };
  validateSourceBundle(researchBundle, 'manifest.researchBundle');

  const pins = [
    {
      entryId: baselineEntry.id,
      commit: baselineCommit,
      treeRef: baselineEntry.treeRef,
      treeObjectId: treeObjectId(baselineCommit, baselineEntry.treeRef),
      commitIsAncestorOfHead: isAncestorOfHead(baselineCommit),
      files: [baselineModel, baselineData, baselineWeight],
    },
    {
      entryId: asppEntry.id,
      commit: asppEntry.commit,
      treeRef: asppEntry.treeRef,
      treeObjectId: treeObjectId(asppEntry.commit as string, asppEntry.treeRef),
      commitIsAncestorOfHead: isAncestorOfHead(asppEntry.commit as string),
      files: [asppFile],
    },
    {
      entryId: seEntry.id,
      commit: seEntry.commit,
      treeRef: seEntry.treeRef,
      treeObjectId: treeObjectId(seEntry.commit as string, seEntry.treeRef),
      commitIsAncestorOfHead: isAncestorOfHead(seEntry.commit as string),
      files: [seFile, modulesManifest],
    },
  ];

  const archivePin = buildArchivePin();

  const manifest = {
    schemaVersion: 1,
    packId: 'phase2-source-pack-v1',
    builtAt: new Date().toISOString(),
    builtBy: 'fixtures/phase2-source-pack/build-manifest.ts',
    repository: {
      headAtBuild: head,
      headSubject: git(['log', '-1', '--format=%s', 'HEAD']),
      remoteUrl: gitOrNull(['config', '--get', 'remote.origin.url']),
      remoteUrlNote:
        'null means no remote is configured. No upstream URL is invented to fill the field; see bundle.unresolved.',
      licenseFilesFound: [],
      licenseFilesNote:
        'Scanned the repository (excluding node_modules, .git and .pnpm-store) for LICENSE, COPYING, NOTICE ' +
        'and COPYRIGHT files: none exist.',
    },
    hashRule: {
      file: 'plain SHA-256 over the raw bytes of the file; no normalization, no line-ending rewrite',
      gitBlob: 'git blob id (SHA-1) of the file at the recorded commit, for cross-checking against the object store',
      tree: 'git tree object id at the recorded commit for the entry treeRef',
      excerpt: 'not used by this manifest; no excerpt is hashed here',
    },
    contract: {
      module: 'packages/evolver/src/contracts/experiments.ts',
      shapes: ['SourceEntry', 'SourceBundle'],
      validatedBy: 'validateSourceBundle (frozen) at build time and again by scripts/verify-phase2-sources.ts',
    },
    bundle: sourceBundle,
    /**
     * The Phase 3 research bundle. Same pinned sources, research-bound proposal.
     * Phase 2 keeps reading `bundle`; Phase 3 reads this one. Neither is a
     * performance claim 閳?see notVerified.
     */
    researchBundle,
    pins,
    provenanceArchives: [
      {
        entry: archivePin.entry,
        inBundle: archivePin.inBundle,
        inBundleReason: archivePin.inBundleReason,
        modelReadable: archivePin.modelReadable,
        modelReadableReason: archivePin.modelReadableReason,
        archivePath: archivePin.archivePath,
        archiveSha256: archivePin.archiveSha256,
        archiveBytes: archivePin.archiveBytes,
        corroboratedBy: {
          path: 'fixtures/mvp-source-pack/manifest.json',
          field: 'sourceArchive.sha256',
          note: 'The pre-existing MVP pack recorded the same digest, which is corroboration, not proof of origin.',
        },
        containerEntries: archivePin.containerEntries,
      },
    ],
    data: {
      ref: bundleBody.dataRef,
      manifestPath: 'fixtures/phase2-source-pack/data/data-manifest.json',
      manifestSha256: dataManifestRef.sha256,
      generatorPath: 'fixtures/phase2-source-pack/data/generate_data.py',
      generatorSha256: sha256Hex(
        fs.readFileSync(path.join(REPO_ROOT, 'fixtures/phase2-source-pack/data/generate_data.py'))
      ),
      preprocessingPath: 'fixtures/phase2-source-pack/data/preprocessing.json',
      preprocessingSha256: sha256Hex(
        fs.readFileSync(path.join(REPO_ROOT, 'fixtures/phase2-source-pack/data/preprocessing.json'))
      ),
      declaredSplits: ['train', 'validation'],
      testSplit: null,
    },
    environment: {
      ref: bundleBody.environmentRef,
      path: 'fixtures/phase2-source-pack/environment.json',
      sha256: environmentRef.sha256,
    },
    notVerified: [
      'No claim is made that any source here is the official implementation of any paper.',
      'No claim is made that any module improves any baseline; that is Phase 3 work and needs a frozen eval.',
      'No claim is made that another machine reproduces these digests; the environment pin is single-host.',
      'The archive provenance pin records where the bytes are, not who authored them.',
    ],
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`WROTE ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
  console.log(`  head              ${head}`);
  console.log(`  sourceBundleHash  ${sourceBundle.sourceBundleHash}`);
  for (const pin of pins) {
    console.log(`  entry ${pin.entryId} commit=${pin.commit.slice(0, 12)} tree=${pin.treeObjectId} files=${pin.files.length}`);
  }
  console.log(
    `  archive ${archivePin.entry.id} contentHash=${archivePin.archiveSha256.slice(0, 16)}... entries=${archivePin.containerEntries.length}`
  );
  console.log(`  unresolved        ${unresolved.length}`);
}

main();
