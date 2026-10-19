import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const HOST_IDS = ['host/profile-install','host/entry-resolution','host/boot','host/authentication','host/route-status','host/auth-fence','host/session-required'];
export const E2E_IDS = ['e2e/native-model','e2e/abc-a','e2e/abc-b','e2e/abc-c','e2e/native-team','e2e/restart','e2e/ui-report'];
export function releaseDigest(root) { return createHash('sha256').update(fs.readFileSync(path.join(root,'verification/release-files.json'))).digest('hex'); }
export function validateEvidence(value, digest, ids) {
  if (!value || value.releaseDigest !== digest) throw new Error('Evidence does not match the current release manifest; rerun the host/E2E verifier');
  if (!Array.isArray(value.checks)) throw new Error('Evidence has no checks');
  if (new Set(value.checks.map(c=>c.id)).size !== value.checks.length) throw new Error('Duplicate evidence check IDs');
  for (const id of ids) if (!value.checks.some(c=>c.id===id)) throw new Error('Missing required evidence case: '+id);
  for (const c of value.checks) if (!['pass','fail','not_run'].includes(c.status)) throw new Error('Invalid evidence status: '+c.id);
  if (value.result === 'pass' && value.checks.some(c=>c.status!=='pass')) throw new Error('Evidence claims pass with incomplete checks');
  if (value.result === 'fail' && !value.checks.some(c=>c.status==='fail')) throw new Error('Evidence failed without a failed check');
  return value.checks;
}
