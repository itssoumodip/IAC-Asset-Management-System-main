import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoiceFields } from '../src/invoice-extract';

const one = `SHREE TECHNOLOGIES PVT LTD
12/4 Park Street, Kolkata 700016
GSTIN: 19AABCS1234F1Z5
TAX INVOICE
Invoice No: ST/2025-26/0457
Invoice Date: 14/08/2025
Dell Latitude 3540 Laptop   1   54,500.00
CGST 9%   4,905.00
SGST 9%   4,905.00
Grand Total: ₹ 64,310.00`;

const two = `Bharat Office Supplies
Bill To: India Autism Center
GST No. 07AAACB5678K1ZP
Invoice Number : BOS-8891
Date : 03-02-2026
Sub Total 10,000.00
Total Rs. 11,800.00`;

const three = `Cloud Netcom Solutions LLP
GSTIN 29AAHFC9999M1Z2
INV NO. CN/889
Dated 5 Mar 2026
Amount in words: Rupees Two Lakh Only
Total Amount  INR 2,36,000.50
Round off 0.00`;

describe('extractInvoiceFields', () => {
  it('reads a standard tax invoice', () => {
    const f = extractInvoiceFields(one);
    assert.equal(f.supplier?.value, 'SHREE TECHNOLOGIES PVT LTD');
    assert.equal(f.invoiceNumber?.value, 'ST/2025-26/0457');
    assert.equal(f.invoiceDate?.value, '2025-08-14');
    assert.equal(f.totalAmount?.value, '64310.00');
    assert.equal(f.gstin?.value, '19AABCS1234F1Z5');
    assert.ok(f.gstin!.confidence > 0.8);
  });
  it('handles Rs. totals, dashes in dates and GST No labels', () => {
    const f = extractInvoiceFields(two);
    assert.equal(f.invoiceNumber?.value, 'BOS-8891');
    assert.equal(f.invoiceDate?.value, '2026-02-03');
    assert.equal(f.totalAmount?.value, '11800.00');
    assert.equal(f.gstin?.value, '07AAACB5678K1ZP');
    assert.equal(f.supplier?.value, 'Bharat Office Supplies');
  });
  it('handles lakh grouping, INR and textual month dates', () => {
    const f = extractInvoiceFields(three);
    assert.equal(f.totalAmount?.value, '236000.50');
    assert.equal(f.invoiceDate?.value, '2026-03-05');
    assert.equal(f.invoiceNumber?.value, 'CN/889');
    assert.equal(f.supplier?.value, 'Cloud Netcom Solutions LLP');
  });
  it('returns nothing for unrelated text', () => {
    const f = extractInvoiceFields('hello world');
    assert.equal(f.totalAmount, undefined);
    assert.equal(f.gstin, undefined);
    assert.equal(f.invoiceNumber, undefined);
    assert.equal(f.invoiceDate, undefined);
  });
});
