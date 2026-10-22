import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { admitPaperSource, discoverPaperSources, readAdmittedPaperSource } from '../../packages/evolver/src/application/paper-source-request.ts';

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-source-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('discovery marks a partial receipt truncated only when a further paper exceeds the file limit', t => {
  const root = workspace(t);
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(root, `${String(i).padStart(3, '0')}.pdf`), 'fixture');
  const complete = discoverPaperSources(root);
  assert.equal(complete.files.length, 100);
  assert.equal(complete.truncated, false);
  assert.deepEqual(complete.errors, []);
  fs.writeFileSync(path.join(root, '100.pdf'), 'overflow');
  const partial = discoverPaperSources(root);
  assert.equal(partial.files.length, 100);
  assert.equal(partial.truncated, true);
  assert.deepEqual(partial.errors.map(({ path, code }) => ({ path, code })), [{ path: '100.pdf', code: 'SOURCE_LIMIT' }]);
  assert.equal(readAdmittedPaperSource(root, partial.requestId, 'file-1').bytes.toString(), 'fixture');
  assert.throws(() => admitPaperSource(root, '.'), /SOURCE_LIMIT/);
});

for (const operation of ['lstatSync', 'readdirSync'] as const) {
  test(`discovery keeps healthy siblings when ${operation} fails, while explicit admission fails`, t => {
    const root = workspace(t);
    const inaccessible = path.join(root, operation === 'lstatSync' ? 'a.pdf' : 'a-directory');
    if (operation === 'lstatSync') fs.writeFileSync(inaccessible, 'fixture');
    else fs.mkdirSync(inaccessible);
    fs.writeFileSync(path.join(root, 'b.pdf'), 'healthy fixture');
    const original = fs[operation];
    const failure = Object.assign(new Error('fixture unavailable'), { code: 'EACCES' });
    // Inject a deterministic OS failure without changing machine permissions.
    t.mock.method(fs, operation, (...args: unknown[]) => {
      if (String(args[0]) === inaccessible) throw failure;
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    try {
      const result = discoverPaperSources(root);
      assert.deepEqual(result.files.map(file => file.name), ['b.pdf']);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.errors.map(({ path, code }) => ({ path, code })), [{ path: path.basename(inaccessible), code: 'EACCES' }]);
      assert.equal(readAdmittedPaperSource(root, result.requestId, 'file-1').bytes.toString(), 'healthy fixture');
      assert.throws(() => admitPaperSource(root, '.'), /EACCES/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test('an aborted discovery does not persist a partial request', t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'a.pdf'), 'fixture');
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => discoverPaperSources(root, '.', controller.signal), { name: 'AbortError' });
  assert.equal(fs.existsSync(path.join(root, '.dsh')), false);
});
