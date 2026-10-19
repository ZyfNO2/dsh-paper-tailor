import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPaperText } from '../../packages/evolver/src/adapters/dsh/paper-library-host.ts';

function selfAuthoredPdf(): Buffer {
  const stream = 'BT /F1 12 Tf 60 750 Td (Synthetic note: no experiments performed.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(body + `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('default PDF intake uses installed parser and preserves extracted text without profile path', async () => {
  const pages = await extractPaperText(selfAuthoredPdf(), 'self-authored.pdf');
  assert.deepEqual(pages, ['Synthetic note: no experiments performed.']);
});

test('explicit unavailable PDF override fails instead of silently switching to default parser', async () => {
  await assert.rejects(extractPaperText(selfAuthoredPdf(), 'self-authored.pdf', 'fixtures/no-such-pdf-parser.mjs'), /ERR_MODULE_NOT_FOUND|Cannot find module/);
});
