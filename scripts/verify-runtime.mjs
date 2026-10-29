// No accounts, database, email or network. Run after the production-only install.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const argon2 = require('argon2');
const sharp = require('sharp');
const Excel = require('exceljs');
const { extractInvoice } = require('./dist/invoice-extract.js');
const password = 'Disposable-runtime-smoke-only';
const hash = await argon2.hash(password);
assert.equal(await argon2.verify(hash, password), true);
const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#334455' } })
  .png()
  .toBuffer();
assert.equal((await sharp(image).jpeg().toBuffer()).subarray(0, 2).toString('hex'), 'ffd8');
const workbook = new Excel.Workbook();
workbook.addWorksheet('Invoice').addRow(['Invoice Number', 'RUNTIME-SYNTHETIC']);
assert.equal(
  (await extractInvoice(Buffer.from(await workbook.xlsx.writeBuffer()), 'XLSX')).suggestions
    .invoiceNumber.value,
  'RUNTIME-SYNTHETIC',
);
const stream = 'BT /F1 12 Tf 40 760 Td (Invoice Number: RUNTIME-SYNTHETIC) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [];
for (const [i, obj] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
}
const start = Buffer.byteLength(pdf);
pdf +=
  'xref\n0 6\n0000000000 65535 f \n' +
  offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
  `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
assert.equal(
  (await extractInvoice(Buffer.from(pdf), 'PDF')).suggestions.invoiceNumber.value,
  'RUNTIME-SYNTHETIC',
);
console.log(
  'Runtime smoke passed: Argon2, Sharp image, XLSX and text-PDF extraction. No DB/SMTP/browser/container certification.',
);
