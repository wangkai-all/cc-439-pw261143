import { inflateSync } from 'node:zlib';

/**
 * Minimal PDF text extraction.
 *
 * This is not a rendering engine. It walks indirect objects, inflates
 * FlateDecode streams and replays the text-showing operators (Tj/TJ/'/") with
 * their positioning operators to recover lines of text. That is enough to read
 * supplier invoices that are born-digital, which is the contract for the PDF
 * intake lane. Scanned/image PDFs yield no text and are quarantined as
 * PDF_NO_TEXT rather than silently accepted with empty fields.
 */

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
  }
}

const decoder = new TextDecoder('latin1');

// A PDF is untrusted input. Bounding the inflated size and the total amount of
// text we keep stops a small file with a highly compressible stream from
// exhausting memory ("zip bomb") or flooding the parser with megabytes of text.
export const MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_STREAMS = 512;

export function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    throw new PdfError('PDF_UNREADABLE', '文件过短，不是有效的 PDF');
  }
  const head = buffer.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) {
    throw new PdfError('PDF_UNREADABLE', '缺少 PDF 文件头');
  }
  if (/\/Encrypt\s*[<\d]/.test(buffer.toString('latin1'))) {
    throw new PdfError('PDF_ENCRYPTED', 'PDF 已加密，无法抽取文本');
  }

  const text = [];
  let streamCount = 0;
  let kept = 0;
  for (const object of iterateObjects(buffer)) {
    if (!object.dict.includes('/Stream') && !object.data) continue;
    if (!object.data) continue;
    streamCount += 1;
    if (streamCount > MAX_STREAMS) break;
    let content;
    try {
      content = decodeStream(object.dict, object.data);
    } catch (err) {
      if (err instanceof PdfError) throw err;
      throw new PdfError('PDF_UNREADABLE', `无法解码内容流：${err.message}`);
    }
    if (!content) continue;
    if (!/\bBT\b/.test(content) || !/(Tj|TJ|'|")/.test(content)) continue;
    const extracted = extractFromContentStream(content);
    if (extracted.trim()) {
      const room = MAX_TEXT_CHARS - kept;
      if (room <= 0) break;
      const piece = extracted.length > room ? extracted.slice(0, room) : extracted;
      kept += piece.length;
      text.push(piece);
    }
  }

  const result = text.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!result) {
    throw new PdfError('PDF_NO_TEXT', 'PDF 没有可抽取的文本层（可能是扫描件）');
  }
  return result;
}

function* iterateObjects(buffer) {
  const raw = buffer.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const start = re.lastIndex;
    const end = raw.indexOf('endobj', start);
    if (end === -1) break;
    const body = raw.slice(start, end);
    const streamAt = body.indexOf('stream');
    if (streamAt === -1) {
      yield { dict: body, data: null };
    } else {
      let dataStart = start + streamAt + 'stream'.length;
      if (raw[dataStart] === '\r') dataStart += 1;
      if (raw[dataStart] === '\n') dataStart += 1;
      const endStream = raw.indexOf('endstream', dataStart);
      if (endStream === -1) continue;
      let dataEnd = endStream;
      // The EOL before endstream is not part of the stream data.
      if (raw[dataEnd - 1] === '\n') dataEnd -= 1;
      if (raw[dataEnd - 1] === '\r') dataEnd -= 1;
      yield {
        dict: body.slice(0, streamAt),
        data: buffer.subarray(dataStart, dataEnd),
      };
    }
    re.lastIndex = end;
  }
}

function decodeStream(dict, data) {
  if (/\/Subtype\s*\/Image/.test(dict)) return null;
  if (/\/Filter\s*\[?\s*\/FlateDecode/.test(dict)) {
    let out;
    try {
      out = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err?.code === 'ERR_OUT_OF_RANGE') {
        throw new PdfError('PDF_TOO_LARGE', `压缩流解压后超过 ${MAX_STREAM_BYTES} 字节上限`);
      }
      try {
        // Some producers truncate the final stream or omit the checksum.
        out = inflateSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */, maxOutputLength: MAX_STREAM_BYTES });
      } catch (retryErr) {
        if (retryErr?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new PdfError('PDF_TOO_LARGE', `压缩流解压后超过 ${MAX_STREAM_BYTES} 字节上限`);
        }
        throw retryErr;
      }
    }
    return decoder.decode(out);
  }
  if (/\/Filter/.test(dict)) {
    // Other filters (ASCII85, LZW, DCT) are not text-bearing for our purposes.
    return null;
  }
  return decoder.decode(data);
}

// --- content stream lexer -------------------------------------------------

function extractFromContentStream(content) {
  const out = [];
  let line = '';
  let operands = [];
  let i = 0;

  const newline = () => {
    if (line.trim() !== '') out.push(line);
    line = '';
  };
  const appendText = (s) => {
    if (!s) return;
    line += s;
    if (/[\r\n]/.test(s)) newline();
  };

  while (i < content.length) {
    const ch = content[i];
    if (ch === '%') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      const [str, next] = readLiteralString(content, i);
      operands.push(str);
      i = next;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end === -1) break;
      const hex = content.slice(i + 1, end).replace(/\s/g, '');
      let s = '';
      for (let k = 0; k + 1 < hex.length; k += 2) {
        s += String.fromCharCode(Number.parseInt(hex.slice(k, k + 2), 16));
      }
      operands.push(s);
      i = end + 1;
      continue;
    }
    if (ch === '[') {
      const arr = [];
      i += 1;
      while (i < content.length && content[i] !== ']') {
        if (/\s/.test(content[i])) { i += 1; continue; }
        if (content[i] === '(') {
          const [str, next] = readLiteralString(content, i);
          arr.push(str);
          i = next;
          continue;
        }
        if (content[i] === '<') {
          const end = content.indexOf('>', i);
          if (end === -1) break;
          const hex = content.slice(i + 1, end).replace(/\s/g, '');
          let s = '';
          for (let k = 0; k + 1 < hex.length; k += 2) s += String.fromCharCode(Number.parseInt(hex.slice(k, k + 2), 16));
          arr.push(s);
          i = end + 1;
          continue;
        }
        const num = /^[-+]?\d*\.?\d+/.exec(content.slice(i));
        if (num) {
          arr.push(Number(num[0]));
          i += num[0].length;
          continue;
        }
        i += 1;
      }
      i += 1;
      operands.push({ array: arr });
      continue;
    }
    if (ch === '/' ) {
      const m = /^\/[^\s<>[\]()/%]*/.exec(content.slice(i));
      operands.push({ name: m ? m[0] : '/' });
      i += m ? m[0].length : 1;
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      // Skip a dictionary operand.
      i += 2;
      let depth = 1;
      while (i < content.length && depth > 0) {
        if (content.startsWith('<<', i)) { depth += 1; i += 2; continue; }
        if (content.startsWith('>>', i)) { depth -= 1; i += 2; continue; }
        i += 1;
      }
      operands.push({ dict: true });
      continue;
    }
    const word = /^[A-Za-z'"*]+/.exec(content.slice(i));
    if (word) {
      const op = word[0];
      i += op.length;
      if (op === 'Tj' || op === "'" || op === '"') {
        if (op !== 'Tj') newline();
        const s = operands.filter((o) => typeof o === 'string').pop() ?? '';
        appendText(s);
      } else if (op === 'TJ') {
        const arr = operands.find((o) => o && o.array)?.array ?? [];
        for (const item of arr) {
          if (typeof item === 'string') appendText(item);
          else if (typeof item === 'number' && item < -100) appendText(' ');
        }
      } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'Tm' || op === 'BT' || op === 'ET') {
        newline();
      } else if (op === 'Do' || op === 'BI') {
        newline();
      }
      operands = [];
      continue;
    }
    const num = /^[-+]?\d*\.?\d+/.exec(content.slice(i));
    if (num) {
      operands.push(Number(num[0]));
      i += num[0].length;
      continue;
    }
    i += 1;
  }
  newline();
  return out.join('\n');
}

function readLiteralString(content, start) {
  let i = start + 1;
  let depth = 1;
  let s = '';
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\\') {
      const next = content[i + 1];
      if (next === 'n') s += '\n';
      else if (next === 'r') s += '\r';
      else if (next === 't') s += '\t';
      else if (next === 'b') s += '\b';
      else if (next === 'f') s += '\f';
      else if (next === '(') s += '(';
      else if (next === ')') s += ')';
      else if (next === '\\') s += '\\';
      else if (next === '\n') { /* line continuation */ }
      else if (next === '\r') { if (content[i + 2] === '\n') i += 1; }
      else if (/[0-7]/.test(next)) {
        let oct = next;
        while (oct.length < 3 && /[0-7]/.test(content[i + 1 + oct.length] ?? '')) oct += content[i + 1 + oct.length];
        s += String.fromCharCode(Number.parseInt(oct, 8));
        i += oct.length - 1;
      } else s += next ?? '';
      i += 2;
      continue;
    }
    if (ch === '(') { depth += 1; s += ch; i += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      i += 1;
      if (depth === 0) return [s, i];
      s += ch;
      continue;
    }
    s += ch;
    i += 1;
  }
  return [s, i];
}
