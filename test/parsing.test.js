import test from 'node:test';
import assert from 'node:assert/strict';

import { deflateSync } from 'node:zlib';

import { parseXml, findAll, textOf, children, MAX_DEPTH, MAX_XML_CHARS } from '../src/lib/xml.js';
import { parseAmount, formatAmount, isValidIsoDate } from '../src/lib/util.js';
import { extractPdfText } from '../src/lib/pdf.js';
import { makeTextPdf } from '../src/lib/pdfgen.js';

test('XML reader handles namespaces, entities and CDATA', () => {
  const doc = parseXml(`<?xml version="1.0"?>
    <ubl:Invoice xmlns:ubl="urn:x" xmlns:cbc="urn:y">
      <cbc:ID>A&amp;B</cbc:ID>
      <cbc:Note><![CDATA[Net 30 & <b>no</b>]]></cbc:Note>
      <cbc:Amount>12.34</cbc:Amount>
    </ubl:Invoice>`);
  assert.equal(doc.local, 'Invoice');
  assert.equal(textOf(doc, 'ID'), 'A&B');
  assert.equal(textOf(doc, 'Note'), 'Net 30 & <b>no</b>');
  assert.equal(textOf(doc, 'Amount'), '12.34');
});

test('XML reader refuses DOCTYPE and unknown entities (XXE)', () => {
  assert.throws(
    () => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Invoice><ID>&e;</ID></Invoice>'),
    /不允许 DOCTYPE/,
  );
  assert.throws(() => parseXml('<Invoice><ID>&nope;</ID></Invoice>'), /未知实体/);
});

test('XML reader reports malformed and truncated documents', () => {
  assert.throws(() => parseXml('<Invoice><ID>1</ID>'), /未闭合/);
  assert.throws(() => parseXml('<Invoice><ID>1</IF></Invoice>'), /不匹配/);
  assert.throws(() => parseXml('<A/><B/>'), /一个根元素/);
  assert.throws(() => parseXml('not xml'), /一个根元素|多余文本/);
});

test('XML reader keeps character offsets for leaf values', () => {
  const source = '<Invoice><ID>42</ID></Invoice>';
  const doc = parseXml(source);
  const id = findAll(doc, 'ID')[0];
  assert.equal(source.slice(id.start, id.end), '42');
});

test('amount parsing is integer-minor-unit and strict', () => {
  assert.equal(parseAmount('12.34'), 1234);
  assert.equal(parseAmount(' 1,250.00 '), 125000);
  assert.equal(parseAmount('€9.5'), 950);
  assert.equal(parseAmount('-3.10'), -310);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('1.234.5'), null);
  assert.equal(formatAmount(1234), '12.34');
  assert.equal(formatAmount(-950), '-9.50');
  assert.equal(formatAmount(5), '0.05');
  assert.equal(isValidIsoDate('2026-02-28'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('28/02/2026'), false);
});

test('PDF text extraction replays Tj/TJ operators and lines', () => {
  const pdf = makeTextPdf([
    'ACME Industrial GmbH',
    'Invoice No. ACME-77',
    'Invoice date: 2026-02-03',
    'Subtotal: 50.00',
    'VAT 19%: 9.50',
    'Total: 59.50',
  ]);
  const text = extractPdfText(pdf);
  assert.match(text, /ACME Industrial GmbH/);
  assert.match(text, /Invoice No\. ACME-77/);
  const lines = text.split('\n');
  assert.ok(lines.includes('Subtotal: 50.00'));
  assert.ok(lines.includes('Total: 59.50'));
});

test('PDF extraction rejects non-PDF and encrypted files', () => {
  assert.throws(() => extractPdfText(Buffer.from('hello')), /缺少 PDF 文件头|过短/);
  const encrypted = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\ntrailer\n<<>>\n%%EOF');
  assert.throws(() => extractPdfText(encrypted), /加密/);
});

test('PDF without a text layer is rejected instead of silently empty', () => {
  const noText = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
  assert.throws(() => extractPdfText(noText), /没有可抽取的文本层/);
});

test('children() filters by local name', () => {
  const doc = parseXml('<R><a x="1"/><b/><a x="2"/></R>');
  assert.equal(children(doc, 'a').length, 2);
  assert.equal(children(doc).length, 3);
});

test('XML reader refuses documents nested past the depth cap', () => {
  const depth = MAX_DEPTH + 5;
  const doc = `${'<a>'.repeat(depth)}x${'</a>'.repeat(depth)}`;
  assert.throws(() => parseXml(doc), /嵌套超过/);
});

test('XML reader refuses documents past the size cap', () => {
  // A single text node larger than the cap: cheap to build, and rejected by
  // length before any parsing work happens.
  const doc = `<Invoice>${' '.repeat(MAX_XML_CHARS)}</Invoice>`;
  assert.throws(() => parseXml(doc), /超过/);
});

test('PDF decompression is bounded against a compression bomb', () => {
  const bomb = deflateSync(Buffer.alloc(20 * 1024 * 1024, 0x42));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + bomb.length + ' /Filter /FlateDecode >>\nstream\n'),
    bomb,
    Buffer.from('\nendstream\nendobj\ntrailer\n<<>>\n%%EOF'),
  ]);
  assert.throws(() => extractPdfText(pdf), /超过/);
});
