import { deflateSync } from 'node:zlib';

/**
 * Build a small, text-bearing PDF for fixtures and the demo inbox.
 * Lines are emitted as separate text-showing operations so the extractor
 * recovers one line per input. Uses FlateDecode like real supplier PDFs.
 */
export function makeTextPdf(lines, { title = 'Invoice' } = {}) {
  const content = [
    'BT',
    '/F1 10 Tf',
    '50 760 Td',
    '14 TL',
    ...lines.flatMap((line) => [
      `(${escapePdfText(line)}) Tj`,
      'T*',
    ]),
    'ET',
  ].join('\n');

  const stream = deflateSync(Buffer.from(content, 'latin1'));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${escapePdfText(title)}) /Producer (invoice-intake fixtures) >>`,
  ];

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

function escapePdfText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
