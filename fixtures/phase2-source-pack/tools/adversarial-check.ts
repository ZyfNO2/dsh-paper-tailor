// Adversarial check: forge a consistent-looking pack and confirm the verifier still rejects it.
// Writes nothing outside fixtures/phase2-source-pack/ and restores byte-exactly in a finally block.
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  sourceBundleBody,
  computeSourceBundleHash,
} from '../../../packages/evolver/src/contracts/experiments.ts';

const dm = 'fixtures/phase2-source-pack/data/data-manifest.json';
const sm = 'fixtures/phase2-source-pack/manifest.json';
const dmOrig = fs.readFileSync(dm);
const smOrig = fs.readFileSync(sm);

function run(label: string): void {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['--experimental-strip-types', 'scripts/verify-phase2-sources.ts'], {
      encoding: 'utf8',
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    code = e.status ?? -1;
  }
  console.log(`--- ${label} ---`);
  console.log(out.split(/\r?\n/).filter((l) => /FAIL|RESULT/.test(l)).join('\n'));
  console.log(`EXIT_CODE=${code}`);
}

try {
  const d = JSON.parse(dmOrig.toString('utf8'));
  // Forge a semantically invalid split layout: validation overlaps train's [0,16).
  d.splits[1].indexRange = [10, 18];
  const dNew = JSON.stringify(d, null, 2) + '\n';
  fs.writeFileSync(dm, dNew);

  // Re-hash EVERYTHING the manifest records, so only a semantic check can catch the forgery.
  const newHash = crypto.createHash('sha256').update(Buffer.from(dNew, 'utf8')).digest('hex');
  const s = JSON.parse(smOrig.toString('utf8'));
  s.data.manifestSha256 = newHash;
  s.data.ref.sha256 = newHash;
  s.bundle.dataRef.sha256 = newHash;
  s.bundle.sourceBundleHash = computeSourceBundleHash(sourceBundleBody(s.bundle) as unknown as Record<string, unknown>);
  fs.writeFileSync(sm, JSON.stringify(s, null, 2) + '\n');

  run('consistently re-hashed forgery: validation indexRange [10,18) overlaps train [0,16)');
} finally {
  fs.writeFileSync(dm, dmOrig);
  fs.writeFileSync(sm, smOrig);
  console.log(`RESTORED_DM=${fs.readFileSync(dm).equals(dmOrig)} RESTORED_SM=${fs.readFileSync(sm).equals(smOrig)}`);
}
